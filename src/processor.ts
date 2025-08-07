import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { TextractService } from './services/textract.service';
import { FusionEngine } from './services/fusion-engine.service';

// Secure environment variable loading with validation
function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Validate and load environment variables
const SUPABASE_URL = getRequiredEnvVar('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = getRequiredEnvVar('SUPABASE_SERVICE_KEY');
const OPENAI_API_KEY = getRequiredEnvVar('OPENAI_API_KEY');

// Validate URL format
try {
  new URL(SUPABASE_URL);
} catch {
  throw new Error('Invalid SUPABASE_URL format');
}

// Initialize clients with validated credentials
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

export interface DocumentJobData {
  documentId: string;
  userId: string;
  fileUrl: string;
  filename: string;
}

export interface ProcessingResult {
  success: boolean;
  processingTime?: number;
  extractedData?: any;
  error?: string;
  extractionMethod?: string;
  confidence?: number;
  costs?: {
    textract?: number;
    openai?: number;
    total?: number;
  };
}

// Helper function to run OpenAI extraction
async function runOpenAIExtraction(jobData: DocumentJobData, buffer: Buffer, isPDF: boolean, isImage: boolean): Promise<any> {
  let completion;
  
  if (isPDF) {
    // For PDFs: Upload to OpenAI Files API first, then use with gpt-4o
    console.log('📤 Uploading PDF to OpenAI Files API...');
    
    // Write buffer to temporary file
    const tempFilePath = path.join('/tmp', jobData.filename);
    fs.writeFileSync(tempFilePath, buffer);
    
    // Create readable stream from temp file
    const fileStream = fs.createReadStream(tempFilePath);

    const file = await openai.files.create({
      file: fileStream,
      purpose: 'assistants'
    });
    
    console.log(`📁 PDF uploaded with file ID: ${file.id}`);
    
    // Create assistant to process the PDF
    const assistant = await openai.beta.assistants.create({
      name: "Invoice Extractor",
      instructions: `You are an invoice data extractor. Your ONLY job is to extract information from PDF documents and return EXACTLY this JSON structure with no additional text, formatting, or explanation:

{
  "accounting_fields": {
    "invoicing_party": { "value": "vendor/company name", "confidence": 0.9 },
    "supplier_invoice_id_by_invcg_party": { "value": "invoice number", "confidence": 0.9 },
    "document_date": { "value": "YYYY-MM-DD or original date format", "confidence": 0.9 },
    "posting_date": { "value": "YYYY-MM-DD or same as document_date", "confidence": 0.9 },
    "invoice_gross_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_text": { "value": "line item descriptions joined with commas", "confidence": 0.9 },
    "document_currency": { "value": "USD or detected currency", "confidence": 0.8 },
    "supplier_invoice_transaction_type": { "value": "Standard Invoice", "confidence": 0.7 },
    "accounting_document_type": { "value": "RE", "confidence": 0.7 },
    "accounting_document_header_text": { "value": "vendor - invoice number", "confidence": 0.8 },
    "debit_credit_code": { "value": "H", "confidence": 0.7 },
    "assignment_reference": { "value": "invoice number", "confidence": 0.8 },
    "company_code": { "value": null, "confidence": 0.5 },
    "gl_account": { "value": null, "confidence": 0.5 },
    "tax_code": { "value": null, "confidence": 0.5 },
    "tax_jurisdiction": { "value": null, "confidence": 0.5 },
    "cost_center": { "value": null, "confidence": 0.5 },
    "profit_center": { "value": null, "confidence": 0.5 },
    "internal_order": { "value": null, "confidence": 0.5 },
    "wbs_element": { "value": null, "confidence": 0.5 }
  }
}

CRITICAL: Return ONLY the JSON object above. No markdown, no code blocks, no explanations, no additional text whatsoever.`,
      model: "gpt-4o",
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          vector_stores: [{
            file_ids: [file.id]
          }]
        }
      }
    });
    
    // Create thread and run
    const thread = await openai.beta.threads.create({
      messages: [{
        role: "user",
        content: "Extract invoice data from the PDF. Return ONLY the JSON object with no formatting or additional text."
      }]
    });
    
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistant.id
    });
    
    // Wait for completion
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    while (runStatus.status === 'in_progress' || runStatus.status === 'queued') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }
    
    if (runStatus.status !== 'completed') {
      throw new Error(`Assistant run failed with status: ${runStatus.status}`);
    }
    
    // Get the response
    const messages = await openai.beta.threads.messages.list(thread.id);
    const lastMessage = messages.data[0];
    
    if (!lastMessage || !lastMessage.content[0] || lastMessage.content[0].type !== 'text') {
      throw new Error('No valid response from assistant');
    }
    
    // Parse the response, handling potential markdown formatting
    let responseText = lastMessage.content[0].text.value;
    console.log('🔍 Raw assistant response:', responseText);
    
    // Remove markdown code blocks if present
    if (responseText.startsWith('```json')) {
      responseText = responseText.replace(/```json\n?/, '').replace(/\n?```$/, '');
    } else if (responseText.startsWith('```')) {
      responseText = responseText.replace(/```\n?/, '').replace(/\n?```$/, '');
    }
    
    // Try to parse JSON
    let extractedData;
    try {
      extractedData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ JSON parse error, raw response:', responseText);
      // Fallback: create a basic structure
      extractedData = {
        vendor_name: "Unable to extract",
        invoice_number: "Parse error",
        invoice_date: null,
        total_amount: 0,
        line_items: [],
        error: "JSON parsing failed"
      };
    }
    
    // Cleanup
    await openai.files.del(file.id);
    await openai.beta.assistants.del(assistant.id);
    
    // Clean up temp file
    fs.unlinkSync(tempFilePath);
    
    completion = {
      choices: [{
        message: {
          content: JSON.stringify(extractedData)
        }
      }]
    };
    
  } else if (isImage) {
    // For Images: Use vision API
    const base64 = buffer.toString('base64');
    const mimeType = jobData.filename.toLowerCase().match(/\.(jpg|jpeg)$/) 
      ? 'image/jpeg'
      : jobData.filename.toLowerCase().endsWith('.png')
        ? 'image/png'
        : jobData.filename.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : jobData.filename.toLowerCase().endsWith('.gif')
            ? 'image/gif'
            : 'image/jpeg';
    
    completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Extract invoice information and return EXACTLY this JSON structure:
{
  "accounting_fields": {
    "invoicing_party": { "value": "vendor/company name", "confidence": 0.9 },
    "supplier_invoice_id_by_invcg_party": { "value": "invoice number", "confidence": 0.9 },
    "document_date": { "value": "YYYY-MM-DD or original date format", "confidence": 0.9 },
    "posting_date": { "value": "YYYY-MM-DD or same as document_date", "confidence": 0.9 },
    "invoice_gross_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_text": { "value": "line item descriptions joined with commas", "confidence": 0.9 },
    "document_currency": { "value": "USD or detected currency", "confidence": 0.8 },
    "supplier_invoice_transaction_type": { "value": "Standard Invoice", "confidence": 0.7 },
    "accounting_document_type": { "value": "RE", "confidence": 0.7 },
    "accounting_document_header_text": { "value": "vendor - invoice number", "confidence": 0.8 },
    "debit_credit_code": { "value": "H", "confidence": 0.7 },
    "assignment_reference": { "value": "invoice number", "confidence": 0.8 },
    "company_code": { "value": null, "confidence": 0.5 },
    "gl_account": { "value": null, "confidence": 0.5 },
    "tax_code": { "value": null, "confidence": 0.5 },
    "tax_jurisdiction": { "value": null, "confidence": 0.5 },
    "cost_center": { "value": null, "confidence": 0.5 },
    "profit_center": { "value": null, "confidence": 0.5 },
    "internal_order": { "value": null, "confidence": 0.5 },
    "wbs_element": { "value": null, "confidence": 0.5 }
  }
}`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the invoice data from this image and return ONLY the JSON structure above with no additional text."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64}`
              }
            }
          ]
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000
    });
    
  } else {
    throw new Error(`Unsupported file type: ${jobData.filename}. Supported types: PDF, JPG, JPEG, PNG, WEBP, GIF`);
  }
  
  // Parse and return result
  const extractedData = JSON.parse(completion.choices[0].message.content || '{}');
  
  return {
    text: completion.choices[0].message.content || '',
    confidence: 0.8, // Default OpenAI confidence
    extraction_method: 'openai-assistants',
    extracted_data: extractedData,
    total_cost: 0.02 // Estimate
  };
}

export async function processDocument(jobData: DocumentJobData): Promise<ProcessingResult> {
  const startTime = Date.now();
  
  try {
    // Validate input
    if (!jobData.documentId || !jobData.userId || !jobData.fileUrl) {
      throw new Error('Invalid job data: missing required fields');
    }
    
    // Validate document ID format (UUID)
    const uuidRegex = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
    if (!uuidRegex.test(jobData.documentId)) {
      throw new Error('Invalid document ID format');
    }
    
    console.log(`📄 Processing document ${jobData.documentId}`);
    
    // Update status to processing
    await supabase
      .from('documents')
      .update({ 
        status: 'processing',
        processing_progress: 10,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobData.documentId)
      .eq('user_id', jobData.userId);
    
    // Validate and download file from Supabase
    console.log(`📥 Downloading file: ${jobData.fileUrl}`);
    
    // Validate file URL format and domain
    try {
      const fileUrlObj = new URL(jobData.fileUrl);
      
      // Only allow Supabase storage URLs
      const allowedDomains = [
        SUPABASE_URL.replace('https://', '').replace('http://', ''),
        'supabase.co',
        'supabase.in'
      ];
      
      const isAllowedDomain = allowedDomains.some(domain => 
        fileUrlObj.hostname === domain || fileUrlObj.hostname.endsWith('.' + domain)
      );
      
      if (!isAllowedDomain) {
        throw new Error(`Unauthorized file URL domain: ${fileUrlObj.hostname}`);
      }
      
      // Only allow HTTPS
      if (fileUrlObj.protocol !== 'https:') {
        throw new Error('Only HTTPS URLs are allowed');
      }
      
    } catch (error) {
      throw new Error(`Invalid file URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    // Extract file path from URL
    let filePath = jobData.fileUrl;
    if (filePath.includes('/storage/v1/object/')) {
      const parts = filePath.split('/storage/v1/object/');
      if (parts[1]) {
        filePath = parts[1].replace('public/documents/', '').replace('documents/', '');
      }
    }
    
    // Validate file path doesn't contain path traversal attempts
    if (filePath.includes('../') || filePath.includes('..\\') || filePath.startsWith('/')) {
      throw new Error('Invalid file path detected');
    }
    
    console.log(`📁 Using validated file path: ${filePath}`);
    
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('documents')
      .download(filePath);
    
    if (downloadError) {
      throw new Error(`Download failed: ${downloadError.message}`);
    }
    
    // Update progress
    await supabase
      .from('documents')
      .update({ 
        processing_progress: 30,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobData.documentId)
      .eq('user_id', jobData.userId);
    
    // Convert file to base64
    const buffer = Buffer.from(await fileData.arrayBuffer());
    
    // Determine file type and processing method
    const isPDF = jobData.filename.toLowerCase().endsWith('.pdf');
    const isImage = Boolean(jobData.filename.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/));
    
    console.log(`🚀 Starting hybrid extraction (Textract + OpenAI) for ${isPDF ? 'PDF' : 'Image'}`);
    
    // Initialize services
    const textractService = new TextractService();
    const fusionEngine = new FusionEngine();
    
    // Run both extractions in parallel for maximum speed
    console.log('⚡ Running parallel extractions...');
    const [textractResult, openaiResult] = await Promise.all([
      textractService.extractFromUrl(jobData.fileUrl),
      runOpenAIExtraction(jobData, buffer, isPDF, isImage)
    ]);
    
    console.log('🔄 Fusing results for maximum accuracy...');
    const hybridResult = await fusionEngine.combine(textractResult, openaiResult);
    
    // Update progress
    await supabase
      .from('documents')
      .update({ 
        processing_progress: 70,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobData.documentId)
      .eq('user_id', jobData.userId);
    
    // Use hybrid result
    const extractedData = {
      // Keep existing format for compatibility
      accounting_fields: hybridResult.businessLogic?.accounting_fields || {},
      
      // Add hybrid-specific data
      textract_data: {
        keyValuePairs: hybridResult.keyValuePairs,
        tables: hybridResult.tables,
        lineItems: hybridResult.lineItems
      },
      
      // Cross-validation info
      cross_validation: hybridResult.crossValidation,
      
      // Confidence and method tracking
      hybrid_confidence: hybridResult.confidence,
      textract_confidence: hybridResult.textract_confidence,
      openai_confidence: hybridResult.openai_confidence
    };
    
    console.log(`✅ Hybrid extraction complete:`);
    console.log(`   📊 Combined confidence: ${(hybridResult.confidence * 100).toFixed(1)}%`);
    console.log(`   🤝 Agreement score: ${(hybridResult.crossValidation.agreementScore * 100).toFixed(1)}%`);
    console.log(`   💰 Total cost: $${hybridResult.total_cost.toFixed(4)}`);

    // Save results and mark as complete
    const { error: updateError } = await supabase
      .from('documents')
      .update({
        status: 'completed',
        processing_progress: 100,
        extracted_data: extractedData,
        extraction_method: 'hybrid-textract-openai',
        extraction_confidence: hybridResult.confidence,
        extraction_cost: hybridResult.total_cost,
        textract_confidence: hybridResult.textract_confidence,
        openai_confidence: hybridResult.openai_confidence,
        cross_validation_score: hybridResult.crossValidation.agreementScore,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobData.documentId)
      .eq('user_id', jobData.userId);
    
    if (updateError) {
      console.error('❌ Failed to update document status:', updateError);
      throw new Error(`Database update failed: ${updateError.message}`);
    }
    
    console.log('✅ Document status updated to completed');
    
    const processingTime = Date.now() - startTime;
    console.log(`✅ Document ${jobData.documentId} processed in ${processingTime}ms`);
    
    return {
      success: true,
      processingTime,
      extractedData,
      extractionMethod: 'hybrid-textract-openai',
      confidence: hybridResult.confidence,
      costs: {
        textract: hybridResult.textract_cost,
        openai: hybridResult.openai_cost,
        total: hybridResult.total_cost
      }
    };
    
  } catch (error) {
    console.error(`❌ Error processing document ${jobData.documentId}:`, error);
    
    // Mark as failed
    try {
      await supabase
        .from('documents')
        .update({
          status: 'failed',
          processing_progress: 0,
          error_message: 'Processing failed',
          updated_at: new Date().toISOString()
        })
        .eq('id', jobData.documentId)
        .eq('user_id', jobData.userId);
    } catch (dbError) {
      console.error('❌ Failed to update document status to failed:', dbError);
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Processing failed'
    };
  }
}