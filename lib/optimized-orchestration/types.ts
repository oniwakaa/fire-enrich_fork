// Simplified types for optimized orchestration
export interface EmailRecord {
  email: string;
  name?: string;
  rowIndex: number;
}

export interface CompanyContext {
  companyKey: string;
  companyName: string;
  domain: string;
  website: string;
  description: string;
  industry: string;
  employeeCount: number;
  location: string;
  investments: string;
  businessPartners: string;
  employeeContacts: string;
  metadata: {
    discoveredAt: string;
    lastVerified: string;
    confidence: number;
  };
}

export interface PersonEnrichment {
  role?: string;
  seniority?: string;
  department?: string;
  confidence: number;
}

export interface EnrichedEmail {
  original: EmailRecord;
  personFields: PersonEnrichment;
  companyContext?: CompanyContext;
  status: 'success' | 'error';
  error?: string;
  processingTime: number;
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

export interface BatchResult {
  enrichedEmails: EnrichedEmail[];
  companyContexts: CompanyContext[];
  metrics: BatchMetrics;
  status: 'completed' | 'partial' | 'failed';
}
