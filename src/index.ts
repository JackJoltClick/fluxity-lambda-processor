import { SQSEvent, SQSRecord, Context } from 'aws-lambda';
import { processDocument } from './processor';

export const handler = async (event: SQSEvent, context: Context) => {
  console.log(`🚀 Lambda: Starting document processing batch`);
  console.log(`📦 Lambda: Processing ${event.Records.length} documents`);

  const results = await Promise.allSettled(
    event.Records.map(async (record: SQSRecord) => {
      try {
        console.log(`🔄 Lambda: Processing message ${record.messageId}`);
        
        const jobData = JSON.parse(record.body);
        console.log(`📋 Lambda: Document ${jobData.documentId} - ${jobData.filename}`);
        
        const result = await processDocument(jobData);
        
        if (result.success) {
          console.log(`✅ Lambda: Document ${jobData.documentId} processed successfully`);
        } else {
          console.error(`❌ Lambda: Document ${jobData.documentId} processing failed:`, result.error);
          throw new Error(result.error);
        }
        
        return result;
      } catch (error) {
        console.error(`❌ Lambda: Message ${record.messageId} failed:`, error);
        throw error;
      }
    })
  );

  const successful = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  console.log(`📊 Lambda: Batch complete - ${successful} successful, ${failed} failed`);

  // If any messages failed, throw an error to send them to DLQ
  if (failed > 0) {
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => (r as PromiseRejectedResult).reason);
    
    throw new Error(`Batch processing failed: ${errors.length} messages failed`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      processed: event.Records.length,
      successful,
      failed
    })
  };
};