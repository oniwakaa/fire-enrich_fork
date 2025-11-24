import { NextRequest, NextResponse } from "next/server";
import type {
  EnrichmentRequest,
  RowEnrichmentResult,
  EnrichmentField,
} from "@/lib/types";
import {
  loadSkipList,
  shouldSkipEmail,
  getSkipReason,
} from "@/lib/utils/skip-list";
import {
  BatchOrchestrator,
  EmailRecord,
} from "@/lib/optimized-orchestration/batch-orchestrator";

export const maxDuration = 86400; // 24 hours timeout for API routes

// Use Node.js runtime for better compatibility
export const runtime = "nodejs";

// Store active sessions in memory (in production, use Redis or similar)
const activeSessions = new Map<string, AbortController>();

export async function POST(request: NextRequest) {
  try {
    // Add request body size check
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
      // 5MB limit
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413 },
      );
    }

    const body: EnrichmentRequest = await request.json();
    const { rows, fields, emailColumn, nameColumn } = body;

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }

    if (!fields || fields.length === 0 || fields.length > 10) {
      return NextResponse.json(
        { error: "Please provide 1-10 fields to enrich" },
        { status: 400 },
      );
    }

    if (!emailColumn) {
      return NextResponse.json(
        { error: "Email column is required" },
        { status: 400 },
      );
    }

    // Use a more compatible UUID generation
    const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const abortController = new AbortController();
    activeSessions.set(sessionId, abortController);

    // Check environment variables and headers for API keys
    const openaiApiKey =
      process.env.OPENAI_API_KEY || request.headers.get("X-OpenAI-API-Key");
    const firecrawlApiKey =
      process.env.FIRECRAWL_API_KEY ||
      request.headers.get("X-Firecrawl-API-Key");

    if (!openaiApiKey || !firecrawlApiKey) {
      console.error("Missing API keys:", {
        hasOpenAI: !!openaiApiKey,
        hasFirecrawl: !!firecrawlApiKey,
      });
      return NextResponse.json(
        { error: "Server configuration error: Missing API keys" },
        { status: 500 },
      );
    }

    // Load skip list
    const skipList = await loadSkipList();

    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send session ID
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "session", sessionId })}\n\n`,
            ),
          );

          // Send pending status for all rows
          for (let i = 0; i < rows.length; i++) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "pending",
                  rowIndex: i,
                  totalRows: rows.length,
                })}\n\n`,
              ),
            );
          }

          // Convert rows to email records for batch processing
          const emailRecords: EmailRecord[] = rows
            .map((row, index) => ({
              email: row[emailColumn] as string,
              name:
                nameColumn && row[nameColumn]
                  ? (row[nameColumn] as string)
                  : undefined,
              rowIndex: index,
            }))
            .filter((record) => record.email && record.email.includes("@"));

          console.log(
            `[ENRICHMENT] Processing ${emailRecords.length} valid email records with batch orchestration`,
          );

          // Initialize optimized orchestration
          const orchestrator = new BatchOrchestrator(
            firecrawlApiKey,
            openaiApiKey,
          );

          // Process with optimized orchestration (with progress reporting)
          let completedCount = 0;

          // Process in smaller batches to provide better progress feedback
          const batchSize = 10;
          const batchResults: any[] = [];

          for (let i = 0; i < emailRecords.length; i += batchSize) {
            // Check if cancelled
            if (abortController.signal.aborted) {
              break;
            }

            const batch = emailRecords.slice(i, i + batchSize);
            console.log(
              `[ENRICHMENT] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(emailRecords.length / batchSize)}`,
            );

            // Send processing status for this batch
            batch.forEach((record) => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "processing",
                    rowIndex: record.rowIndex,
                    totalRows: rows.length,
                  })}\n\n`,
                ),
              );
            });

            try {
              const batchResult = await orchestrator.processEmailBatch(
                batch,
                fields as EnrichmentField[],
                emailColumn,
              );

              batchResults.push(...batchResult.enrichedEmails);

              // Send results for this batch
              batchResult.enrichedEmails.forEach((result) => {
                completedCount++;

                // Check if email should be skipped
                if (
                  result.original.email &&
                  shouldSkipEmail(result.original.email, skipList)
                ) {
                  const skipReason = getSkipReason(
                    result.original.email,
                    skipList,
                  );

                  const skipResult: RowEnrichmentResult = {
                    rowIndex: result.original.rowIndex,
                    originalData: rows[result.original.rowIndex],
                    enrichments: {},
                    status: "skipped",
                    error: skipReason,
                  };

                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: "result",
                        result: skipResult,
                      })}\n\n`,
                    ),
                  );
                  return;
                }

                // Convert batch result to expected format
                const rowResult: RowEnrichmentResult = {
                  rowIndex: result.original.rowIndex,
                  originalData: rows[result.original.rowIndex],
                  enrichments: result.enrichments || {},
                  status: result.status === "success" ? "completed" : "error",
                  error: result.error,
                };

                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "result",
                      result: rowResult,
                    })}\n\n`,
                  ),
                );
              });
            } catch (error) {
              // Handle batch processing error
              batch.forEach((record) => {
                const errorResult: RowEnrichmentResult = {
                  rowIndex: record.rowIndex,
                  originalData: rows[record.rowIndex],
                  enrichments: {},
                  status: "error",
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                };

                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "result",
                      result: errorResult,
                    })}\n\n`,
                  ),
                );
              });
            }
          }

          // Send completion
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "complete" })}\n\n`),
          );
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: error instanceof Error ? error.message : "Unknown error",
              })}\n\n`,
            ),
          );
        } finally {
          activeSessions.delete(sessionId);
          controller.close();
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Failed to start enrichment:", error);
    return NextResponse.json(
      {
        error: "Failed to start enrichment",
        details: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

// Cancel endpoint
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json({ error: "Session ID required" }, { status: 400 });
  }

  const controller = activeSessions.get(sessionId);
  if (controller) {
    controller.abort();
    activeSessions.delete(sessionId);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Session not found" }, { status: 404 });
}
