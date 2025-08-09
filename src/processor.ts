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

// Helper function to map Textract data using OpenAI (text-only, no document upload)
async function runTextOnlyMapping(textractData: any): Promise<any> {
  const startTime = Date.now()
  
  // Build the mapping prompt with Textract data
  const prompt = `You are an expert at mapping extracted invoice data to a standardized accounting schema.

I have extracted the following raw data from an invoice using OCR:

**KEY-VALUE PAIRS:**
${JSON.stringify(textractData.keyValuePairs, null, 2)}

**LINE ITEMS:**
${JSON.stringify(textractData.lineItems || [], null, 2)}

**TABLE DATA:**
${textractData.tables?.length ? JSON.stringify(textractData.tables, null, 2) : 'No table data'}

Your task is to intelligently map this raw extracted data to the following standardized accounting schema. Use your understanding of invoice structures and business context to make the best mappings.

Return EXACTLY this JSON structure with mapped values and confidence scores (0.0 to 1.0):

{
  "accounting_fields": {
    "invoicing_party": { "value": "vendor/company name", "confidence": 0.9 },
    "supplier_invoice_id_by_invcg_party": { "value": "invoice number", "confidence": 0.9 },
    "document_date": { "value": "YYYY-MM-DD format", "confidence": 0.9 },
    "posting_date": { "value": "YYYY-MM-DD format", "confidence": 0.9 },
    "invoice_gross_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_text": { "value": "line item descriptions", "confidence": 0.9 },
    "document_currency": { "value": "USD/EUR/etc", "confidence": 0.8 },
    "supplier_invoice_transaction_type": { "value": "Standard Invoice", "confidence": 0.7 },
    "accounting_document_type": { "value": "RE", "confidence": 0.7 },
    "accounting_document_header_text": { "value": "vendor - invoice", "confidence": 0.8 },
    "debit_credit_code": { "value": "H", "confidence": 0.7 },
    "assignment_reference": { "value": "invoice reference", "confidence": 0.8 },
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

MAPPING GUIDELINES:
- Look for patterns like "Total", "Amount Due" → invoice_gross_amount
- Look for "Date", "Invoice Date" → document_date  
- Look for vendor/company names → invoicing_party
- Look for invoice numbers, PO numbers → supplier_invoice_id_by_invcg_party
- Combine line items into supplier_invoice_item_text
- Convert dates to YYYY-MM-DD format
- Use confidence scores: 0.9+ for exact matches, 0.7-0.9 for good matches, 0.5-0.7 for uncertain matches
- Set null values with confidence 0.5 for fields you cannot determine

Return only the JSON, no other text.`

  try {
    console.log('🤖 OpenAI: Sending Textract data for schema mapping...')
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Cheaper model for text-only processing
      messages: [
        {
          role: 'system',
          content: 'You are an expert at mapping extracted invoice data to standardized accounting schemas. Always return valid JSON.'
        },
        {
          role: 'user', 
          content: prompt
        }
      ],
      temperature: 0.1, // Low temperature for consistent mapping
      max_tokens: 2000
    })

    const responseContent = completion.choices[0].message.content?.trim()
    
    if (!responseContent) {
      throw new Error('Empty response from OpenAI')
    }

    console.log('🔍 OpenAI mapping response:', responseContent)

    // Parse the JSON response
    let parsedResult: any
    try {
      parsedResult = JSON.parse(responseContent)
    } catch (parseError) {
      console.error('❌ Failed to parse OpenAI response as JSON:', parseError)
      throw new Error(`Invalid JSON response: ${responseContent}`)
    }

    const processingTime = Date.now() - startTime
    const cost = (completion.usage?.total_tokens || 0) * 0.000002 // Rough estimate for gpt-4o-mini

    console.log(`✅ OpenAI mapping complete in ${processingTime}ms, cost ~$${cost.toFixed(4)}`)

    return {
      text: JSON.stringify(parsedResult.accounting_fields),
      confidence: 0.9, // High confidence for AI mapping
      extraction_method: 'hybrid-textract-openai',
      extracted_data: parsedResult.accounting_fields,
      total_cost: cost
    }

  } catch (error) {
    console.error('❌ OpenAI mapping failed:', error)
    throw error
  }
}

// Helper function to run OpenAI extraction
async function runOpenAIExtraction(
  jobData: DocumentJobData, 
  buffer: Buffer, 
  isPDF: boolean, 
  isImage: boolean, 
  textractData?: any
): Promise<any> {
  let completion;
  
  // Debug what we actually received
  console.log('🔍 OpenAI: Checking textractData:', {
    hasTextractData: !!textractData,
    keyValuePairsKeys: textractData ? Object.keys(textractData.keyValuePairs || {}).length : 0,
    textractDataKeys: textractData ? Object.keys(textractData) : []
  })
  
  // NEW APPROACH: If we have Textract data, use it instead of re-analyzing the document
  if (textractData && Object.keys(textractData.keyValuePairs || {}).length > 0) {
    console.log('🎯 OpenAI: Processing Textract extracted data (hybrid mode)')
    return await runTextOnlyMapping(textractData)
  }
  
  // FALLBACK: If no Textract data, analyze document directly
  console.log('📄 OpenAI: No Textract data available, analyzing document directly')
  
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
    
    // Build enhanced instructions with Textract context
    let instructions = `You are an expert invoice data extractor. Extract information from PDF documents and return EXACTLY this JSON structure:

{
  "accounting_fields": {
    "invoicing_party": { "value": "vendor/company name", "confidence": 0.9 },
    "supplier_invoice_id_by_invcg_party": { "value": "invoice number", "confidence": 0.9 },
    "document_date": { "value": "YYYY-MM-DD format", "confidence": 0.9 },
    "posting_date": { "value": "YYYY-MM-DD format", "confidence": 0.9 },
    "invoice_gross_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_text": { "value": "line item descriptions", "confidence": 0.9 },
    "document_currency": { "value": "USD/EUR/etc", "confidence": 0.8 },
    "supplier_invoice_transaction_type": { "value": "Standard Invoice", "confidence": 0.7 },
    "accounting_document_type": { "value": "RE", "confidence": 0.7 },
    "accounting_document_header_text": { "value": "vendor - invoice", "confidence": 0.8 },
    "debit_credit_code": { "value": "H", "confidence": 0.7 },
    "assignment_reference": { "value": "invoice reference", "confidence": 0.8 },
    "company_code": { "value": null, "confidence": 0.5 },
    "gl_account": { "value": null, "confidence": 0.5 },
    "tax_code": { "value": null, "confidence": 0.5 },
    "tax_jurisdiction": { "value": null, "confidence": 0.5 },
    "cost_center": { "value": null, "confidence": 0.5 },
    "profit_center": { "value": null, "confidence": 0.5 },
    "internal_order": { "value": null, "confidence": 0.5 },
    "wbs_element": { "value": null, "confidence": 0.5 }
  }
}`;

    // Add Textract context if available
    if (textractData) {
      instructions += `

TEXTRACT STRUCTURED DATA AVAILABLE:
Key-Value Pairs: ${JSON.stringify(textractData.keyValuePairs, null, 2)}
Line Items: ${JSON.stringify(textractData.lineItems, null, 2)}
Tables: ${textractData.tables?.length || 0} tables detected

Use this structured data to enhance accuracy. Cross-reference values and prefer structured data over OCR text when available.`;
    }

    instructions += `

FIELD MAPPING RULES:
- invoicing_party: Look for vendor/supplier name, company name
- supplier_invoice_id_by_invcg_party: Invoice number, invoice ID, document number
- document_date: Invoice date, document date, issue date
- posting_date: Same as document_date unless specified differently
- invoice_gross_amount: Total amount, grand total, amount due (as number)
- supplier_invoice_item_amount: Line item total, subtotal (as number)
- supplier_invoice_item_text: Combine all line item descriptions with commas
- document_currency: Currency symbol or code (USD, EUR, etc)

EXAMPLES:
- If you see "ABC Company" → invoicing_party: "ABC Company"
- If you see "INV-12345" → supplier_invoice_id_by_invcg_party: "INV-12345"
- If you see "$1,234.56" → invoice_gross_amount: 1234.56
- If you see "01/15/2024" → document_date: "2024-01-15"

CRITICAL: Return ONLY the JSON object. No markdown, no code blocks, no explanations.`;

    // Create assistant to process the PDF
    const assistant = await openai.beta.assistants.create({
      name: "Invoice Extractor",
      instructions,
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
        content: textractData 
          ? "Extract invoice data from the PDF using the Textract structured data provided in your instructions. Cross-reference and return ONLY the JSON object with no formatting or additional text."
          : "Extract invoice data from the PDF. Return ONLY the JSON object with no formatting or additional text."
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
    
    // Build enhanced system message with Textract context
    let systemContent = `Extract invoice information and return EXACTLY this JSON structure:
{
  "accounting_fields": {
    "invoicing_party": { "value": "vendor/company name", "confidence": 0.9 },
    "supplier_invoice_id_by_invcg_party": { "value": "invoice number", "confidence": 0.9 },
    "document_date": { "value": "YYYY-MM-DD format", "confidence": 0.9 },
    "posting_date": { "value": "YYYY-MM-DD format", "confidence": 0.9 },
    "invoice_gross_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_amount": { "value": number, "confidence": 0.9 },
    "supplier_invoice_item_text": { "value": "line item descriptions", "confidence": 0.9 },
    "document_currency": { "value": "USD/EUR/etc", "confidence": 0.8 },
    "supplier_invoice_transaction_type": { "value": "Standard Invoice", "confidence": 0.7 },
    "accounting_document_type": { "value": "RE", "confidence": 0.7 },
    "accounting_document_header_text": { "value": "vendor - invoice", "confidence": 0.8 },
    "debit_credit_code": { "value": "H", "confidence": 0.7 },
    "assignment_reference": { "value": "invoice reference", "confidence": 0.8 },
    "company_code": { "value": null, "confidence": 0.5 },
    "gl_account": { "value": null, "confidence": 0.5 },
    "tax_code": { "value": null, "confidence": 0.5 },
    "tax_jurisdiction": { "value": null, "confidence": 0.5 },
    "cost_center": { "value": null, "confidence": 0.5 },
    "profit_center": { "value": null, "confidence": 0.5 },
    "internal_order": { "value": null, "confidence": 0.5 },
    "wbs_element": { "value": null, "confidence": 0.5 }
  }
}`;

    // Add Textract context if available
    if (textractData) {
      systemContent += `

TEXTRACT STRUCTURED DATA AVAILABLE:
Key-Value Pairs: ${JSON.stringify(textractData.keyValuePairs, null, 2)}
Line Items: ${JSON.stringify(textractData.lineItems, null, 2)}
Tables: ${textractData.tables?.length || 0} tables detected

Use this structured data to enhance accuracy. Cross-reference values and prefer structured data over OCR text when available.`;
    }

    systemContent += `

FIELD MAPPING RULES:
- invoicing_party: Look for vendor/supplier name, company name
- supplier_invoice_id_by_invcg_party: Invoice number, invoice ID, document number
- document_date: Invoice date, document date, issue date (convert to YYYY-MM-DD)
- posting_date: Same as document_date unless specified differently
- invoice_gross_amount: Total amount, grand total, amount due (as number)
- supplier_invoice_item_amount: Line item total, subtotal (as number)
- supplier_invoice_item_text: Combine all line item descriptions with commas
- document_currency: Currency symbol or code (USD, EUR, etc)

EXAMPLES:
- "ABC Company" → invoicing_party: "ABC Company"
- "INV-12345" → supplier_invoice_id_by_invcg_party: "INV-12345"
- "$1,234.56" → invoice_gross_amount: 1234.56
- "01/15/2024" → document_date: "2024-01-15"`;

    completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: systemContent
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: textractData 
                ? "Extract the invoice data from this image using the Textract structured data provided above. Cross-reference and return ONLY the JSON structure with no additional text."
                : "Extract the invoice data from this image and return ONLY the JSON structure above with no additional text."
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
    
    // Pass 1: Run Textract extraction first
    console.log('⚡ Pass 1: Running Textract extraction...');
    const textractResult = await textractService.extractFromUrl(jobData.fileUrl);
    
    // Pass 2: Now run OpenAI with Textract data for intelligent mapping
    console.log('🔍 Pass 2: Running OpenAI with Textract data for schema mapping...');
    const openaiResult = await runOpenAIExtraction(jobData, buffer, isPDF, isImage, textractResult);
    
    console.log('🔍 OpenAI Result Debug:', {
      hasResult: !!openaiResult,
      resultKeys: openaiResult ? Object.keys(openaiResult) : [],
      hasExtractedData: !!openaiResult?.extracted_data,
      extractedDataType: typeof openaiResult?.extracted_data,
      extractedDataKeys: openaiResult?.extracted_data ? Object.keys(openaiResult.extracted_data) : [],
      extractedDataSample: openaiResult?.extracted_data,
      confidence: openaiResult?.confidence,
      extractionMethod: openaiResult?.extraction_method
    })
    
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
      
      // Direct field mapping results
      field_mappings: hybridResult.fieldMappings,
      
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

    // Extract individual field values from the hybrid result's accounting fields
    // The accounting_fields are in the extractedData we just built above
    const accountingFields = extractedData.accounting_fields || {};
    
    console.log('🔍 Lambda: Extracting field values for database from:', Object.keys(accountingFields));
    
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
        
        // Extract individual field values from accounting_fields
        company_code: accountingFields.company_code?.value || null,
        supplier_invoice_transaction_type: accountingFields.supplier_invoice_transaction_type?.value || null,
        invoicing_party: accountingFields.invoicing_party?.value || null,
        supplier_invoice_id_by_invcg_party: accountingFields.supplier_invoice_id_by_invcg_party?.value || null,
        document_date: accountingFields.document_date?.value || null,
        posting_date: accountingFields.posting_date?.value || null,
        accounting_document_type: accountingFields.accounting_document_type?.value || null,
        accounting_document_header_text: accountingFields.accounting_document_header_text?.value || null,
        document_currency: accountingFields.document_currency?.value || null,
        invoice_gross_amount: accountingFields.invoice_gross_amount?.value || null,
        gl_account: accountingFields.gl_account?.value || null,
        supplier_invoice_item_text: accountingFields.supplier_invoice_item_text?.value || null,
        debit_credit_code: accountingFields.debit_credit_code?.value || null,
        supplier_invoice_item_amount: accountingFields.supplier_invoice_item_amount?.value || null,
        tax_code: accountingFields.tax_code?.value || null,
        tax_jurisdiction: accountingFields.tax_jurisdiction?.value || null,
        assignment_reference: accountingFields.assignment_reference?.value || null,
        cost_center: accountingFields.cost_center?.value || null,
        profit_center: accountingFields.profit_center?.value || null,
        internal_order: accountingFields.internal_order?.value || null,
        wbs_element: accountingFields.wbs_element?.value || null,
        
        // Set mapping confidence and accounting status
        mapping_confidence: hybridResult.confidence,
        accounting_status: hybridResult.confidence >= 0.8 ? 'ready_for_export' : 'needs_mapping',
        requires_review: hybridResult.confidence < 0.7,
        
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