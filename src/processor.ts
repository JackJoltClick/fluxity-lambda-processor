import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!
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
    
    // Download file from Supabase
    console.log(`📥 Downloading file: ${jobData.fileUrl}`);
    
    // Extract file path from URL
    let filePath = jobData.fileUrl;
    if (filePath.includes('/storage/v1/object/')) {
      const parts = filePath.split('/storage/v1/object/');
      if (parts[1]) {
        filePath = parts[1].replace('public/documents/', '').replace('documents/', '');
      }
    }
    
    console.log(`📁 Using file path: ${filePath}`);
    
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
    const isImage = jobData.filename.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/);
    
    console.log(`🤖 Calling OpenAI for extraction (File type: ${isPDF ? 'PDF' : 'Image'})`);
    
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
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Extract invoice information from the document. Return JSON with: vendor_name, invoice_number, invoice_date, total_amount, line_items (array with description and amount)"
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract the invoice data from this image"
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
    
    // Update progress
    await supabase
      .from('documents')
      .update({ 
        processing_progress: 70,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobData.documentId)
      .eq('user_id', jobData.userId);
    
    // Parse extracted data - OpenAI now returns the exact format we need
    const extractedData = JSON.parse(completion.choices[0].message.content || '{}');
    console.log(`✅ Extraction complete:`, extractedData);

    // Save results and mark as complete
    const { error: updateError } = await supabase
      .from('documents')
      .update({
        status: 'completed',
        processing_progress: 100,
        extracted_data: extractedData,
        extraction_method: 'openai-assistants',
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
      extractedData
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