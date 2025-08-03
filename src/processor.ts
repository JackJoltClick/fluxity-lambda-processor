import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

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
      // For PDFs: Use gpt-4o (supports PDF processing)
      const base64 = buffer.toString('base64');
      
      completion = await openai.chat.completions.create({
        model: "gpt-4o",
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
                text: "Extract the invoice data from this PDF document"
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:application/pdf;base64,${base64}`
                }
              }
            ]
          }
        ],
        response_format: { type: "json_object" },
        max_tokens: 2000
      });
      
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
    
    // Parse extracted data
    const extractedData = JSON.parse(completion.choices[0].message.content || '{}');
    console.log(`✅ Extraction complete:`, extractedData);
    
    // Save results and mark as complete
    const { error: updateError } = await supabase
      .from('documents')
      .update({
        status: 'completed',
        processing_progress: 100,
        extracted_data: extractedData,
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