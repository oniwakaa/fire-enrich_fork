import { NextRequest, NextResponse } from "next/server";
import Papa from "papaparse";
import type { CSVRow, EnrichmentField } from "@/lib/types";
import { BatchOrchestrator } from "@/lib/optimized-orchestration/batch-orchestrator";

export const runtime = "nodejs";
export const maxDuration = 86400; // 24 hours timeout for API routes

// Standard enrichment fields with new employee contacts, business partners, and investments
const STANDARD_FIELDS: EnrichmentField[] = [
  {
    name: "company_name",
    displayName: "Company Name",
    description: "The name of the company",
    type: "string",
    required: false,
  },
  {
    name: "company_description",
    displayName: "Company Description",
    description: "A brief description of what the company does",
    type: "string",
    required: false,
  },
  {
    name: "industry",
    displayName: "Industry",
    description: "The industry or sector the company operates in",
    type: "string",
    required: false,
  },
  {
    name: "employee_count",
    displayName: "Employee Count",
    description: "Approximate number of employees",
    type: "string",
    required: false,
  },
  {
    name: "location",
    displayName: "Location",
    description: "Company headquarters location",
    type: "string",
    required: false,
  },
  {
    name: "website",
    displayName: "Website",
    description: "Company website URL",
    type: "string",
    required: false,
  },
  {
    name: "investments",
    displayName: "Investments",
    description: "Investment information, funding rounds, and investor details",
    type: "string",
    required: false,
  },
  {
    name: "employee_contacts",
    displayName: "Employee Contacts",
    description:
      "Senior and mid-level employee names and titles from team/leadership pages",
    type: "string",
    required: false,
  },
  {
    name: "business_partners",
    displayName: "Business Partners",
    description: "Partner companies, integrations, and ecosystem relationships",
    type: "string",
    required: false,
  },
];

export async function POST(request: NextRequest) {
  try {
    console.log(
      "[CSV_API_OPTIMIZED] Starting optimized CSV enrichment request",
    );

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const emailColumn = formData.get("emailColumn") as string | null;
    const fieldsParam = formData.get("fields") as string | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json(
        { error: "Invalid file type. Please upload a CSV file" },
        { status: 400 },
      );
    }

    if (!emailColumn) {
      return NextResponse.json(
        { error: "Email column is required" },
        { status: 400 },
      );
    }

    // Parse CSV
    const csvText = await file.text();
    const parseResult = Papa.parse(csvText, { header: true });
    const parsedRows = parseResult.data as CSVRow[];

    if (parsedRows.length === 0) {
      return NextResponse.json(
        { error: "No data found in CSV file" },
        { status: 400 },
      );
    }

    // Check if email column exists
    const columns = Object.keys(parsedRows[0]);
    if (!columns.includes(emailColumn)) {
      return NextResponse.json(
        { error: `Email column "${emailColumn}" not found` },
        { status: 400 },
      );
    }

    // Determine fields to enrich
    let fieldsToEnrich = STANDARD_FIELDS;
    if (fieldsParam) {
      try {
        const requestedFields = JSON.parse(fieldsParam);
        fieldsToEnrich = STANDARD_FIELDS.filter(
          (field) =>
            requestedFields.includes(field.name) ||
            requestedFields.includes(field.displayName),
        );
      } catch {
        return NextResponse.json(
          { error: "Invalid fields parameter" },
          { status: 400 },
        );
      }
    }

    // Check environment variables
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;

    if (!openaiApiKey || !firecrawlApiKey) {
      return NextResponse.json(
        { error: "Server configuration error: Missing API keys" },
        { status: 500 },
      );
    }

    console.log(
      `[CSV_API_OPTIMIZED] Processing ${parsedRows.length} rows with optimized orchestration`,
    );

    // Initialize optimized orchestration
    const orchestrator = new BatchOrchestrator(firecrawlApiKey, openaiApiKey);

    // Convert CSV rows to email records format
    const emailRecords = parsedRows
      .map((row, index) => ({
        email: (row[emailColumn] as string) || "",
        name: (row["name"] as string) || undefined,
        rowIndex: index,
      }))
      .filter((record) => record.email && record.email.includes("@"));

    console.log(
      `[CSV_API_OPTIMIZED] Converted ${emailRecords.length} valid email records`,
    );

    // Process with optimized orchestration
    const batchResult = await orchestrator.processEmailBatch(
      emailRecords,
      fieldsToEnrich,
      emailColumn,
    );

    // Convert results back to CSV format
    const enrichedResults: CSVRow[] = [];

    // Create a lookup for enriched data by email
    const enrichedLookup = new Map<string, any>();
    batchResult.enrichedEmails.forEach((enriched) => {
      enrichedLookup.set(enriched.original.email, enriched);
    });

    // Map back to original CSV rows
    for (let i = 0; i < parsedRows.length; i++) {
      const originalRow = parsedRows[i];
      const email = originalRow[emailColumn] as string;
      const enrichedRow: CSVRow = { ...originalRow };

      const enrichedData = enrichedLookup.get(email);
      if (enrichedData && enrichedData.status === "success") {
        // Add enriched fields from the enrichments object
        if (enrichedData.enrichments) {
          Object.entries(enrichedData.enrichments).forEach(
            ([fieldName, enrichment]) => {
              if (
                enrichment &&
                enrichment.value !== null &&
                enrichment.value !== undefined
              ) {
                enrichedRow[fieldName] = String(enrichment.value);
              }
            },
          );
        }

        enrichedRow["enrichment_status"] = "completed";
        enrichedRow["enrichment_confidence"] =
          enrichedData.enrichments?.confidence?.toString() || "0";
      } else {
        // Handle errors
        enrichedRow["enrichment_status"] = enrichedData?.status || "error";
        enrichedRow["enrichment_error"] =
          enrichedData?.error || "Unknown error";
      }

      enrichedResults.push(enrichedRow);
    }

    console.log(
      `[CSV_API_OPTIMIZED] Processing completed. Success: ${batchResult.metrics.successfulEmails}/${batchResult.metrics.totalEmails}`,
    );

    // Convert to CSV
    const csv = Papa.unparse(enrichedResults);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="enriched_${file.name}"`,
        "X-Processed-Rows": batchResult.metrics.totalEmails.toString(),
        "X-Enriched-Rows": batchResult.metrics.successfulEmails.toString(),
        "X-Processing-Time": batchResult.metrics.totalProcessingTime.toString(),
        "X-API-Calls": batchResult.metrics.apiCallCount.toString(),
        "X-Cache-Hit-Rate": batchResult.metrics.cacheHitRate.toString(),
      },
    });
  } catch (error) {
    console.error("[CSV_API_OPTIMIZED] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
