import { TextractResult } from './textract.service'
import { applyFieldMappings } from '../config/field-mappings'

export interface OpenAIResult {
  text: string
  confidence: number
  extraction_method: string
  extracted_data?: any
  total_cost?: number
}

export interface HybridExtractionResult {
  // Core data (best of both worlds)
  text: string
  confidence: number
  
  // Structured data from Textract
  keyValuePairs: Record<string, string>
  tables: Array<{ rows: string[][], confidence: number }>
  lineItems: Array<{
    description: string
    quantity?: string
    unitPrice?: string
    amount?: string
    confidence: number
  }>
  
  // Business intelligence from OpenAI
  businessLogic?: any
  normalizedData?: any
  
  // Direct field mapping results
  fieldMappings?: {
    mapped: Record<string, any>
    unmapped: Record<string, any>
    mappingDetails: Array<{
      sourceKey: string
      targetField: string
      value: any
      confidence: number
    }>
    mappingTrail?: Array<{
      sourceKey: string
      sourceValue: any
      targetField: string
      mappedValue: any
      confidence: number
      method: string
    }>
  }
  
  // Cross-validation results
  crossValidation: {
    agreementScore: number // 0-1, how much both services agree
    conflictingFields: string[]
    validatedFields: Record<string, {
      textractValue: any
      openaiValue: any
      finalValue: any
      confidence: number
      source: 'textract' | 'openai' | 'consensus' | 'direct-mapping'
    }>
  }
  
  // Method tracking
  extraction_method: 'hybrid'
  textract_confidence: number
  openai_confidence: number
  
  // Cost tracking
  total_cost: number
  textract_cost: number
  openai_cost: number
  
  // Raw data for debugging
  textract_raw?: any
  openai_raw?: any
}

export class FusionEngine {
  
  async combine(textractResult: TextractResult, openaiResult: OpenAIResult): Promise<HybridExtractionResult> {
    console.log('🔄 Fusion: Starting hybrid analysis...')
    console.log('🔍 Fusion: Textract key-value pairs:', Object.keys(textractResult.keyValuePairs))
    
    // Apply direct field mappings to Textract's key-value pairs
    const fieldMappings = applyFieldMappings(textractResult.keyValuePairs)
    console.log(`📋 Direct mapping: ${Object.keys(fieldMappings.mapped).filter(k => fieldMappings.mapped[k] !== null).length} fields mapped`)
    console.log(`❓ Unmapped fields: ${Object.keys(fieldMappings.unmapped).length}`)
    console.log('📋 Mapped fields:', Object.entries(fieldMappings.mapped).filter(([k,v]) => v !== null).map(([k,v]) => `${k}=${v}`))
    
    // NEW: Create a mapping trail for the UI to display
    const mappingTrail = fieldMappings.mappingDetails.map(detail => ({
      sourceKey: detail.sourceKey,
      sourceValue: textractResult.keyValuePairs[detail.sourceKey],
      targetField: detail.targetField,
      mappedValue: detail.value,
      confidence: detail.confidence,
      method: 'textract-direct'
    }))
    
    // Cross-validate critical fields
    const crossValidation = this.performCrossValidation(textractResult, openaiResult, fieldMappings)
    
    // Calculate hybrid confidence score
    const hybridConfidence = this.calculateHybridConfidence(
      textractResult.confidence,
      openaiResult.confidence,
      crossValidation.agreementScore
    )
    
    // Combine text (prefer Textract's structured extraction)
    const combinedText = this.combineText(textractResult.text, openaiResult.text)
    
    // Extract business logic from OpenAI result
    const businessLogic = this.extractBusinessLogic(openaiResult)
    
    // Merge direct mappings with OpenAI's accounting fields
    const mergedAccountingFields = this.mergeAccountingFields(
      fieldMappings.mapped,
      businessLogic.accounting_fields || {}
    )
    
    // Update business logic with merged fields
    businessLogic.accounting_fields = mergedAccountingFields
    
    // Calculate costs
    const textractCost = this.calculateTextractCost(textractResult)
    const openaiCost = openaiResult.total_cost || 0
    
    const result: HybridExtractionResult = {
      // Core combined data
      text: combinedText,
      confidence: hybridConfidence,
      
      // Structured data (Textract's strength)
      keyValuePairs: textractResult.keyValuePairs,
      tables: textractResult.tables,
      lineItems: textractResult.lineItems,
      
      // Business intelligence (OpenAI's strength)
      businessLogic,
      normalizedData: this.normalizeData(textractResult, openaiResult),
      
      // Direct field mapping results  
      fieldMappings: {
        mapped: fieldMappings.mapped,
        unmapped: fieldMappings.unmapped,
        mappingDetails: fieldMappings.mappingDetails,
        mappingTrail // Add the detailed mapping trail for UI display
      },
      
      // Cross-validation
      crossValidation,
      
      // Method tracking
      extraction_method: 'hybrid',
      textract_confidence: textractResult.confidence,
      openai_confidence: openaiResult.confidence,
      
      // Cost tracking
      total_cost: textractCost + openaiCost,
      textract_cost: textractCost,
      openai_cost: openaiCost,
      
      // Raw data
      textract_raw: textractResult.textract_raw,
      openai_raw: openaiResult.extracted_data || openaiResult
    }
    
    console.log(`✅ Fusion: Hybrid analysis complete`)
    console.log(`🎯 Fusion: Combined confidence: ${(hybridConfidence * 100).toFixed(1)}%`)
    console.log(`🤝 Fusion: Agreement score: ${(crossValidation.agreementScore * 100).toFixed(1)}%`)
    console.log(`💰 Fusion: Total cost: $${result.total_cost.toFixed(4)}`)
    
    return result
  }

  private mergeAccountingFields(directMapped: Record<string, any>, openaiFields: Record<string, any>): Record<string, any> {
    const merged: Record<string, any> = {};
    
    // Get all unique field names
    const allFields = new Set([
      ...Object.keys(directMapped),
      ...Object.keys(openaiFields)
    ]);
    
    allFields.forEach(field => {
      const directValue = directMapped[field];
      const openaiValue = openaiFields[field]?.value || openaiFields[field];
      
      // Prefer direct mapping if available, otherwise use OpenAI
      if (directValue !== null && directValue !== undefined) {
        merged[field] = {
          value: directValue,
          confidence: 0.95,
          source: 'direct-mapping'
        };
      } else if (openaiValue !== null && openaiValue !== undefined) {
        merged[field] = {
          value: openaiValue,
          confidence: openaiFields[field]?.confidence || 0.8,
          source: 'openai'
        };
      } else {
        merged[field] = {
          value: null,
          confidence: 0,
          source: 'none'
        };
      }
    });
    
    return merged;
  }

  private performCrossValidation(textractResult: TextractResult, openaiResult: OpenAIResult, fieldMappings?: any): HybridExtractionResult['crossValidation'] {
    const validatedFields: Record<string, any> = {}
    const conflictingFields: string[] = []
    
    // Common fields to cross-validate
    const commonFields = [
      'invoice_number', 'invoice_date', 'due_date', 'vendor_name', 
      'total_amount', 'subtotal', 'tax_amount', 'currency'
    ]
    
    let agreements = 0
    let totalComparisons = 0
    
    commonFields.forEach(fieldName => {
      const textractValue = this.extractFieldFromTextract(fieldName, textractResult)
      const openaiValue = this.extractFieldFromOpenAI(fieldName, openaiResult)
      
      if (textractValue || openaiValue) {
        totalComparisons++
        
        const isMatch = this.fieldsMatch(textractValue, openaiValue, fieldName)
        
        if (isMatch) {
          agreements++
          validatedFields[fieldName] = {
            textractValue,
            openaiValue,
            finalValue: textractValue || openaiValue,
            confidence: 0.95, // High confidence when both agree
            source: 'consensus' as const
          }
        } else {
          conflictingFields.push(fieldName)
          
          // Choose the more confident source
          const textractConfidence = this.getFieldConfidence(fieldName, textractResult)
          const openaiConfidence = this.getFieldConfidence(fieldName, openaiResult)
          
          if (textractConfidence > openaiConfidence) {
            validatedFields[fieldName] = {
              textractValue,
              openaiValue,
              finalValue: textractValue,
              confidence: textractConfidence * 0.8, // Slight penalty for disagreement
              source: 'textract' as const
            }
          } else {
            validatedFields[fieldName] = {
              textractValue,
              openaiValue,
              finalValue: openaiValue,
              confidence: openaiConfidence * 0.8,
              source: 'openai' as const
            }
          }
        }
      }
    })
    
    const agreementScore = totalComparisons > 0 ? agreements / totalComparisons : 0.5
    
    return {
      agreementScore,
      conflictingFields,
      validatedFields
    }
  }

  private calculateHybridConfidence(textractConf: number, openaiConf: number, agreementScore: number): number {
    // Weighted average with agreement bonus
    const baseConfidence = (textractConf * 0.6) + (openaiConf * 0.4) // Textract weighted higher for structure
    const agreementBonus = agreementScore * 0.1 // Up to 10% bonus for agreement
    
    return Math.min(baseConfidence + agreementBonus, 1.0)
  }

  private combineText(textractText: string, openaiText: string): string {
    // Prefer Textract's structured text extraction
    return textractText || openaiText
  }

  private extractBusinessLogic(openaiResult: OpenAIResult): any {
    console.log('🔍 Fusion: Extracting business logic from OpenAI result:', {
      hasExtractedData: !!openaiResult.extracted_data,
      extractedDataType: typeof openaiResult.extracted_data,
      extractedDataKeys: openaiResult.extracted_data ? Object.keys(openaiResult.extracted_data) : [],
      extractedDataSample: openaiResult.extracted_data
    })
    
    // Extract business intelligence from OpenAI result
    if (openaiResult.extracted_data) {
      // The OpenAI result puts accounting fields directly in extracted_data
      // Not nested under extracted_data.accounting_fields
      return {
        // Pass through the accounting fields directly - they're the root of extracted_data
        accounting_fields: openaiResult.extracted_data || {},
        businessRules: openaiResult.extracted_data.business_rules || {},
        interpretations: openaiResult.extracted_data.interpretations || {},
        normalizations: openaiResult.extracted_data.normalizations || {}
      }
    }
    
    console.log('⚠️ Fusion: No extracted_data found in OpenAI result, returning empty business logic')
    return { accounting_fields: {} }
  }

  private normalizeData(textractResult: TextractResult, openaiResult: OpenAIResult): any {
    // Combine and normalize data from both sources
    return {
      // Use Textract's precise structure
      tables: textractResult.tables,
      keyValuePairs: textractResult.keyValuePairs,
      
      // Use OpenAI's business logic interpretations
      businessContext: openaiResult.extracted_data || {},
      
      // Combined line items with enhanced data
      enhancedLineItems: this.enhanceLineItems(textractResult.lineItems, openaiResult)
    }
  }

  private enhanceLineItems(textractLineItems: any[], openaiResult: OpenAIResult): any[] {
    // Enhance Textract line items with OpenAI business logic
    return textractLineItems.map(item => ({
      ...item,
      // Add any business logic enhancements from OpenAI
      businessCategory: this.categorizeLineItem(item.description, openaiResult),
      normalizedAmount: this.normalizeAmount(item.amount),
      glAccountSuggestion: this.suggestGLAccount(item, openaiResult)
    }))
  }

  private categorizeLineItem(description: string, openaiResult: OpenAIResult): string | undefined {
    // Extract category suggestions from OpenAI result
    const extracted = openaiResult.extracted_data
    if (extracted?.line_items) {
      const matchingItem = extracted.line_items.find((item: any) => 
        item.description?.toLowerCase().includes(description?.toLowerCase())
      )
      return matchingItem?.category
    }
    return undefined
  }

  private normalizeAmount(amount?: string): number | undefined {
    if (!amount) return undefined
    
    // Remove currency symbols and normalize
    const cleanAmount = amount.replace(/[^\d.,]/g, '')
    const normalized = parseFloat(cleanAmount.replace(',', ''))
    
    return isNaN(normalized) ? undefined : normalized
  }

  private suggestGLAccount(item: any, openaiResult: OpenAIResult): string | undefined {
    // Extract GL account suggestions from OpenAI business logic
    const extracted = openaiResult.extracted_data
    return extracted?.gl_suggestions?.[item.description] || undefined
  }

  private extractFieldFromTextract(fieldName: string, result: TextractResult): any {
    // Map common field names to Textract key-value pairs
    const fieldMappings: Record<string, string[]> = {
      'invoice_number': ['Invoice Number', 'Invoice #', 'Number', 'Doc Number'],
      'invoice_date': ['Invoice Date', 'Date', 'Issue Date'],
      'due_date': ['Due Date', 'Payment Due'],
      'vendor_name': ['Vendor', 'Company', 'From', 'Supplier'],
      'total_amount': ['Total', 'Amount Due', 'Grand Total'],
      'subtotal': ['Subtotal', 'Sub Total'],
      'tax_amount': ['Tax', 'Sales Tax', 'VAT'],
      'currency': ['Currency', 'CCY']
    }
    
    const possibleKeys = fieldMappings[fieldName] || [fieldName]
    
    for (const key of possibleKeys) {
      for (const [kvKey, kvValue] of Object.entries(result.keyValuePairs)) {
        if (kvKey.toLowerCase().includes(key.toLowerCase())) {
          return kvValue
        }
      }
    }
    
    return null
  }

  private extractFieldFromOpenAI(fieldName: string, result: OpenAIResult): any {
    const extracted = result.extracted_data
    if (!extracted) return null
    
    // Try direct field access
    if (extracted[fieldName]) return extracted[fieldName]
    
    // Try common variations
    const variations = [
      fieldName.replace('_', ' '),
      fieldName.replace('_', ''),
      fieldName.toLowerCase(),
      fieldName.toUpperCase()
    ]
    
    for (const variation of variations) {
      if (extracted[variation]) return extracted[variation]
    }
    
    return null
  }

  private fieldsMatch(value1: any, value2: any, fieldType: string): boolean {
    if (!value1 || !value2) return false
    
    // Type-specific matching logic
    switch (fieldType) {
      case 'invoice_date':
      case 'due_date':
        return this.datesMatch(value1, value2)
      
      case 'total_amount':
      case 'subtotal':
      case 'tax_amount':
        return this.amountsMatch(value1, value2)
      
      default:
        return this.stringsMatch(value1, value2)
    }
  }

  private datesMatch(date1: string, date2: string): boolean {
    // Normalize and compare dates
    const normalized1 = new Date(date1).toISOString().split('T')[0]
    const normalized2 = new Date(date2).toISOString().split('T')[0]
    return normalized1 === normalized2
  }

  private amountsMatch(amount1: string, amount2: string): boolean {
    const num1 = this.normalizeAmount(amount1)
    const num2 = this.normalizeAmount(amount2)
    
    if (!num1 || !num2) return false
    
    // Allow 1% difference for rounding
    const difference = Math.abs(num1 - num2)
    const average = (num1 + num2) / 2
    return difference / average < 0.01
  }

  private stringsMatch(str1: string, str2: string): boolean {
    // Simple string similarity
    const clean1 = str1.toLowerCase().trim()
    const clean2 = str2.toLowerCase().trim()
    
    return clean1 === clean2 || 
           clean1.includes(clean2) || 
           clean2.includes(clean1)
  }

  private getFieldConfidence(fieldName: string, result: TextractResult | OpenAIResult): number {
    if ('textract_raw' in result) {
      // Textract result - use its confidence
      return result.confidence
    } else {
      // OpenAI result - use its confidence
      return result.confidence || 0.8
    }
  }

  private calculateTextractCost(result: TextractResult): number {
    // Estimate Textract cost based on features used
    // Base OCR: $0.0015, Forms: $0.05, Tables: $0.015
    // Assume 1 page and all features used
    return 0.065 // $0.065 per page for full extraction
  }
}