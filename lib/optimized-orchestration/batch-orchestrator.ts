// Simplified batch orchestrator that optimizes the existing agent system
import { AgentEnrichmentStrategy } from "@/lib/strategies/agent-enrichment-strategy";
import { CompanyCache } from "./company-cache";
import { StaircaseBackoff } from "./staircase-backoff";
import type { CSVRow, EnrichmentField } from "@/lib/types";

export interface EmailRecord {
  email: string;
  name?: string;
  rowIndex: number;
}

export interface BatchResult {
  enrichedEmails: EnrichedEmail[];
  metrics: BatchMetrics;
  status: "completed" | "partial" | "failed";
}

export interface EnrichedEmail {
  original: EmailRecord;
  status: "success" | "error";
  error?: string;
  processingTime: number;
  enrichments: Record<string, any>;
}

export interface BatchMetrics {
  totalEmails: number;
  successfulEmails: number;
  failedEmails: number;
  uniqueCompanies: number;
  totalProcessingTime: number;
  averageLatencyPerEmail: number;
  apiCallCount: number;
  cacheHitRate: number;
  costBreakdown: {
    firecrawlCredits: number;
    estimatedCostUSD: number;
  };
}

/**
 * Optimized batch orchestrator that wraps the existing agent system
 * with company-first caching and intelligent rate limiting
 */
export class BatchOrchestrator {
  private enrichmentStrategy: AgentEnrichmentStrategy;
  private cache: CompanyCache;
  private rateLimiter: StaircaseBackoff;

  constructor(
    firecrawlApiKey: string,
    openaiApiKey: string,
    cache?: CompanyCache,
    rateLimiter?: StaircaseBackoff,
  ) {
    this.enrichmentStrategy = new AgentEnrichmentStrategy(
      openaiApiKey,
      firecrawlApiKey,
    );
    this.cache = cache || new CompanyCache();
    this.rateLimiter =
      rateLimiter ||
      new StaircaseBackoff({
        maxRetries: 3,
        baseDelay: 2000,
        maxDelay: 30000,
        defaultQPS: 1,
        maxConcurrentRequests: 5,
      });
  }

  /**
   * Process email batch with optimized orchestration
   * Uses company caching to reduce redundant API calls
   */
  async processEmailBatch(
    emails: EmailRecord[],
    fieldsToEnrich: EnrichmentField[],
    emailColumn: string = "email",
  ): Promise<BatchResult> {
    const startTime = Date.now();
    console.log(`[BatchOrchestrator] Processing ${emails.length} emails`);

    // Group emails by domain for company-level caching
    const domainGroups = this.groupEmailsByDomain(emails);
    console.log(
      `[BatchOrchestrator] Found ${domainGroups.size} unique domains`,
    );

    // Track processing metrics
    const processedEmails: EnrichedEmail[] = [];
    const companyCacheHits = new Set<string>();
    let apiCallCount = 0;

    // Process each email with rate limiting and caching
    for (let i = 0; i < emails.length; i++) {
      const emailRecord = emails[i];
      const emailDomain = this.extractDomain(emailRecord.email);

      if (!emailDomain) {
        processedEmails.push({
          original: emailRecord,
          status: "error",
          error: "Invalid email format",
          processingTime: 0,
          enrichments: {},
        });
        continue;
      }

      const emailStartTime = Date.now();

      try {
        // Check cache for company context
        const cacheKey = this.cache.generateCacheKey(emailDomain, emailDomain);
        const cachedResult = await this.cache.get(cacheKey);

        if (cachedResult) {
          companyCacheHits.add(emailDomain);
          console.log(
            `[BatchOrchestrator] Cache hit for domain: ${emailDomain}`,
          );

          // Use cached result but still call enrichment for person-specific fields
          const result = await this.rateLimiter.execute(
            () =>
              this.enrichmentStrategy.enrichRow(
                {
                  [emailColumn]: emailRecord.email,
                  name: emailRecord.name || "",
                },
                fieldsToEnrich,
                emailColumn,
                cachedResult, // Pass cached company data
              ),
            "firecrawl/enrich",
            2, // 2 QPS for enrichment
          );

          processedEmails.push({
            original: emailRecord,
            status: result.status === "error" ? "error" : "success",
            error: result.error,
            processingTime: Date.now() - emailStartTime,
            enrichments: result.enrichments || {},
          });
        } else {
          // No cache - process normally and cache result
          console.log(
            `[BatchOrchestrator] Processing new domain: ${emailDomain}`,
          );

          const result = await this.rateLimiter.execute(
            () =>
              this.enrichmentStrategy.enrichRow(
                {
                  [emailColumn]: emailRecord.email,
                  name: emailRecord.name || "",
                },
                fieldsToEnrich,
                emailColumn,
              ),
            "firecrawl/enrich",
            1, // 1 QPS for new research
          );

          // Cache successful results
          if (result.status !== "error" && result.enrichments) {
            // Create simplified company context from enrichments
            const companyContext = this.extractCompanyContext(
              result.enrichments,
            );
            if (companyContext) {
              await this.cache.set(
                cacheKey,
                companyContext,
                7 * 24 * 60 * 60 * 1000,
              ); // 7 days
            }
          }

          processedEmails.push({
            original: emailRecord,
            status: result.status === "error" ? "error" : "success",
            error: result.error,
            processingTime: Date.now() - emailStartTime,
            enrichments: result.enrichments || {},
          });
        }

        // Estimate API calls (this is approximate)
        apiCallCount += 5; // Rough estimate per email
      } catch (error) {
        console.error(
          `[BatchOrchestrator] Error processing email ${emailRecord.email}:`,
          error,
        );

        processedEmails.push({
          original: emailRecord,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
          processingTime: Date.now() - emailStartTime,
          enrichments: {},
        });
      }
    }

    const totalTime = Date.now() - startTime;
    const successfulEmails = processedEmails.filter(
      (e) => e.status === "success",
    ).length;
    const cacheHitRate = companyCacheHits.size / domainGroups.size || 0;

    const metrics: BatchMetrics = {
      totalEmails: emails.length,
      successfulEmails,
      failedEmails: emails.length - successfulEmails,
      uniqueCompanies: domainGroups.size,
      totalProcessingTime: totalTime,
      averageLatencyPerEmail: totalTime / emails.length,
      apiCallCount,
      cacheHitRate,
      costBreakdown: {
        firecrawlCredits: apiCallCount,
        estimatedCostUSD: apiCallCount * 0.001, // $0.001 per credit estimate
      },
    };

    console.log(`[BatchOrchestrator] Batch completed in ${totalTime}ms`);
    console.log(
      `[BatchOrchestrator] Success rate: ${successfulEmails}/${emails.length}`,
    );
    console.log(
      `[BatchOrchestrator] Cache hit rate: ${(cacheHitRate * 100).toFixed(1)}%`,
    );

    return {
      enrichedEmails: processedEmails,
      metrics,
      status:
        successfulEmails === emails.length
          ? "completed"
          : successfulEmails > 0
            ? "partial"
            : "failed",
    };
  }

  // Helper methods
  private groupEmailsByDomain(
    emails: EmailRecord[],
  ): Map<string, EmailRecord[]> {
    const groups = new Map<string, EmailRecord[]>();

    for (const email of emails) {
      const domain = this.extractDomain(email.email);
      if (!domain) continue;

      if (!groups.has(domain)) {
        groups.set(domain, []);
      }
      groups.get(domain)!.push(email);
    }

    return groups;
  }

  private extractDomain(email: string): string | null {
    if (!email || !email.includes("@")) return null;
    return email.split("@")[1].toLowerCase();
  }

  private extractCompanyContext(enrichments: Record<string, any>): any {
    // Extract company information from enrichments for caching
    const context: any = {
      companyName: enrichments.company_name?.value || "",
      domain: "", // Will be set from cache key
      website: enrichments.website?.value || "",
      description: enrichments.company_description?.value || "",
      industry: enrichments.industry?.value || "",
      employeeCount: enrichments.employee_count?.value || 0,
      location: enrichments.location?.value || "",
      investments: enrichments.investments?.value || "",
      businessPartners: enrichments.business_partners?.value || "",
      employeeContacts: enrichments.employee_contacts?.value || "",
      metadata: {
        discoveredAt: new Date().toISOString(),
        lastVerified: new Date().toISOString(),
        confidence: 0.8, // Estimated confidence
      },
    };

    return context;
  }
}
