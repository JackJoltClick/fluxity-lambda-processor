import { 
  TextractClient, 
  AnalyzeDocumentCommand,
  FeatureType,
  Block,
  BlockType
} from '@aws-sdk/client-textract'

export interface TextractResult {
  text: string
  confidence: number
  keyValuePairs: Record<string, string>
  tables: Array<{
    rows: string[][]
    confidence: number
  }>
  lineItems: Array<{
    description: string
    quantity?: string
    unitPrice?: string
    amount?: string
    confidence: number
  }>
  extraction_method: 'textract'
  textract_raw: any // Store raw Textract response
}

export class TextractService {
  private client: TextractClient

  constructor() {
    this.client = new TextractClient({
      region: process.env.AWS_REGION || 'us-east-1'
    })
  }

  async extractFromUrl(fileUrl: string): Promise<TextractResult> {
    try {
      console.log(`📄 Textract: Starting extraction for ${fileUrl}`)
      
      // Download the document
      const response = await fetch(fileUrl)
      if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.statusText}`)
      }
      
      const buffer = await response.arrayBuffer()
      const document = new Uint8Array(buffer)

      // Analyze document with all features for maximum accuracy
      const command = new AnalyzeDocumentCommand({
        Document: { Bytes: document },
        FeatureTypes: [
          FeatureType.FORMS,  // Key-value pairs
          FeatureType.TABLES  // Table extraction
        ]
      })

      const result = await this.client.send(command)
      console.log(`✅ Textract: Analysis complete, processing ${result.Blocks?.length || 0} blocks`)

      return this.processTextractResponse(result)
      
    } catch (error) {
      console.error('❌ Textract extraction failed:', error)
      throw new Error(`Textract extraction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private processTextractResponse(response: any): TextractResult {
    const blocks = response.Blocks || []
    
    // Extract text and calculate confidence
    const textBlocks = blocks.filter((block: Block) => block.BlockType === BlockType.LINE)
    const text = textBlocks.map((block: Block) => block.Text).join('\n')
    const textConfidence = this.calculateAverageConfidence(textBlocks)

    // Extract key-value pairs
    const keyValuePairs = this.extractKeyValuePairs(blocks)
    
    // Extract tables
    const tables = this.extractTables(blocks)
    
    // Extract line items from tables (invoice-specific logic)
    const lineItems = this.extractLineItems(tables)

    const result: TextractResult = {
      text,
      confidence: textConfidence,
      keyValuePairs,
      tables,
      lineItems,
      extraction_method: 'textract',
      textract_raw: response // Store for debugging/advanced processing
    }

    console.log(`📊 Textract: Extracted ${Object.keys(keyValuePairs).length} key-value pairs, ${tables.length} tables, ${lineItems.length} line items`)
    console.log(`🎯 Textract: Overall confidence: ${(textConfidence * 100).toFixed(1)}%`)

    return result
  }

  private calculateAverageConfidence(blocks: Block[]): number {
    if (blocks.length === 0) return 0
    
    const totalConfidence = blocks.reduce((sum, block) => {
      return sum + (block.Confidence || 0)
    }, 0)
    
    return totalConfidence / blocks.length / 100 // Convert to 0-1 scale
  }

  private extractKeyValuePairs(blocks: Block[]): Record<string, string> {
    const keyValuePairs: Record<string, string> = {}
    
    // Find KEY_VALUE_SET blocks
    const kvBlocks = blocks.filter(block => block.BlockType === BlockType.KEY_VALUE_SET)
    
    const keyBlocks = kvBlocks.filter(block => block.EntityTypes?.includes('KEY'))
    
    keyBlocks.forEach(keyBlock => {
      if (!keyBlock.Relationships) return
      
      // Find associated VALUE block
      const valueRelationship = keyBlock.Relationships.find(rel => rel.Type === 'VALUE')
      if (!valueRelationship?.Ids) return
      
      const valueBlock = blocks.find(block => 
        valueRelationship.Ids?.includes(block.Id || '')
      )
      
      if (valueBlock) {
        const keyText = this.getBlockText(keyBlock, blocks).trim()
        const valueText = this.getBlockText(valueBlock, blocks).trim()
        
        if (keyText && valueText) {
          keyValuePairs[keyText] = valueText
        }
      }
    })
    
    return keyValuePairs
  }

  private extractTables(blocks: Block[]): Array<{ rows: string[][], confidence: number }> {
    const tables: Array<{ rows: string[][], confidence: number }> = []
    
    const tableBlocks = blocks.filter(block => block.BlockType === BlockType.TABLE)
    
    tableBlocks.forEach(tableBlock => {
      if (!tableBlock.Relationships) return
      
      const cellRelationship = tableBlock.Relationships.find(rel => rel.Type === 'CHILD')
      if (!cellRelationship?.Ids) return
      
      // Get all cells for this table
      const cellBlocks = blocks.filter(block => 
        cellRelationship.Ids?.includes(block.Id || '') && 
        block.BlockType === BlockType.CELL
      )
      
      // Organize cells into rows
      const rowMap: Record<number, Record<number, string>> = {}
      
      cellBlocks.forEach(cell => {
        const rowIndex = cell.RowIndex || 0
        const colIndex = cell.ColumnIndex || 0
        const cellText = this.getBlockText(cell, blocks)
        
        if (!rowMap[rowIndex]) rowMap[rowIndex] = {}
        rowMap[rowIndex][colIndex] = cellText
      })
      
      // Convert to 2D array
      const rows: string[][] = []
      const sortedRowIndices = Object.keys(rowMap).map(Number).sort((a, b) => a - b)
      
      sortedRowIndices.forEach(rowIndex => {
        const rowData = rowMap[rowIndex]
        const sortedColIndices = Object.keys(rowData).map(Number).sort((a, b) => a - b)
        const row = sortedColIndices.map(colIndex => rowData[colIndex] || '')
        rows.push(row)
      })
      
      tables.push({
        rows,
        confidence: this.calculateAverageConfidence(cellBlocks)
      })
    })
    
    return tables
  }

  private extractLineItems(tables: Array<{ rows: string[][], confidence: number }>): Array<{
    description: string
    quantity?: string
    unitPrice?: string
    amount?: string
    confidence: number
  }> {
    const lineItems: any[] = []
    
    // Process each table to find line items
    tables.forEach(table => {
      if (table.rows.length < 2) return // Need header + at least one data row
      
      const headerRow = table.rows[0]
      const dataRows = table.rows.slice(1)
      
      // Try to identify common invoice columns
      const descriptionColIndex = this.findColumnIndex(headerRow, ['description', 'item', 'product', 'service'])
      const quantityColIndex = this.findColumnIndex(headerRow, ['quantity', 'qty', 'amount'])
      const priceColIndex = this.findColumnIndex(headerRow, ['price', 'rate', 'unit price', 'cost'])
      const totalColIndex = this.findColumnIndex(headerRow, ['total', 'amount', 'line total'])
      
      dataRows.forEach(row => {
        if (row.some(cell => cell.trim())) { // Skip empty rows
          const lineItem: any = {
            confidence: table.confidence
          }
          
          if (descriptionColIndex >= 0 && row[descriptionColIndex]) {
            lineItem.description = row[descriptionColIndex].trim()
          }
          if (quantityColIndex >= 0 && row[quantityColIndex]) {
            lineItem.quantity = row[quantityColIndex].trim()
          }
          if (priceColIndex >= 0 && row[priceColIndex]) {
            lineItem.unitPrice = row[priceColIndex].trim()
          }
          if (totalColIndex >= 0 && row[totalColIndex]) {
            lineItem.amount = row[totalColIndex].trim()
          }
          
          // Only add if we have at least a description
          if (lineItem.description) {
            lineItems.push(lineItem)
          }
        }
      })
    })
    
    return lineItems
  }

  private findColumnIndex(headerRow: string[], searchTerms: string[]): number {
    return headerRow.findIndex(header => 
      searchTerms.some(term => 
        header.toLowerCase().includes(term.toLowerCase())
      )
    )
  }

  private getBlockText(block: Block, allBlocks: Block[]): string {
    if (block.Text) {
      return block.Text
    }
    
    if (!block.Relationships) return ''
    
    // Get child blocks and combine their text
    const childRelationship = block.Relationships.find(rel => rel.Type === 'CHILD')
    if (!childRelationship?.Ids) return ''
    
    const childTexts = childRelationship.Ids
      .map(id => allBlocks.find(b => b.Id === id))
      .filter(b => b?.Text)
      .map(b => b!.Text!)
    
    return childTexts.join(' ')
  }
}