/**
 * Direct field mapping configuration
 * Maps common invoice field names to SAP accounting fields
 */

export interface FieldMapping {
  // The SAP/accounting field name
  targetField: string;
  // Common variations of field names that map to this field
  sourceVariations: string[];
  // Field type for validation/formatting
  fieldType: 'text' | 'number' | 'date' | 'currency';
  // Optional transformation function
  transform?: (value: string) => any;
}

// Date transformation helper
const parseDate = (value: string): string => {
  try {
    const date = new Date(value);
    return date.toISOString().split('T')[0]; // YYYY-MM-DD format
  } catch {
    return value; // Return original if parsing fails
  }
};

// Amount transformation helper
const parseAmount = (value: string): number => {
  // Remove currency symbols, commas, and spaces
  const cleaned = value.replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned) || 0;
};

export const FIELD_MAPPINGS: FieldMapping[] = [
  {
    targetField: 'invoicing_party',
    sourceVariations: [
      'vendor', 'vendor name', 'supplier', 'supplier name', 'company',
      'from', 'bill from', 'seller', 'merchant', 'billed by', 'invoice from',
      'vendor company', 'supplier company'
    ],
    fieldType: 'text'
  },
  {
    targetField: 'supplier_invoice_id_by_invcg_party',
    sourceVariations: [
      'invoice number', 'invoice #', 'invoice no', 'invoice id',
      'document number', 'document #', 'doc number', 'bill number',
      'reference number', 'reference #', 'inv #', 'inv number',
      'invoice ref', 'bill #'
    ],
    fieldType: 'text'
  },
  {
    targetField: 'document_date',
    sourceVariations: [
      'invoice date', 'date', 'issue date', 'document date',
      'bill date', 'created date', 'dated', 'invoice issued',
      'date of invoice', 'billing date'
    ],
    fieldType: 'date',
    transform: parseDate
  },
  {
    targetField: 'posting_date',
    sourceVariations: [
      'posting date', 'post date', 'received date', 'entry date',
      'accounting date', 'book date'
    ],
    fieldType: 'date',
    transform: parseDate
  },
  {
    targetField: 'invoice_gross_amount',
    sourceVariations: [
      'total', 'total amount', 'grand total', 'amount due',
      'total due', 'balance due', 'invoice total', 'gross amount',
      'total payable', 'amount payable', 'final amount', 'net payable',
      'payment due', 'total invoice amount'
    ],
    fieldType: 'number',
    transform: parseAmount
  },
  {
    targetField: 'supplier_invoice_item_amount',
    sourceVariations: [
      'subtotal', 'sub total', 'net amount', 'net total',
      'pre-tax amount', 'amount before tax', 'goods total',
      'services total', 'line items total', 'items total'
    ],
    fieldType: 'number',
    transform: parseAmount
  },
  {
    targetField: 'supplier_invoice_item_text',
    sourceVariations: [
      'description', 'line items', 'items', 'goods/services',
      'product description', 'service description', 'details',
      'item description', 'billing items'
    ],
    fieldType: 'text'
  },
  {
    targetField: 'document_currency',
    sourceVariations: [
      'currency', 'ccy', 'curr', 'currency code', 'invoice currency',
      'payment currency', 'denomination'
    ],
    fieldType: 'currency'
  },
  {
    targetField: 'tax_code',
    sourceVariations: [
      'tax', 'tax rate', 'tax %', 'vat', 'vat rate', 'sales tax',
      'tax percentage', 'gst', 'tax code'
    ],
    fieldType: 'text'
  },
  {
    targetField: 'assignment_reference',
    sourceVariations: [
      'reference', 'ref', 'po number', 'purchase order', 'po #',
      'order number', 'order #', 'contract #', 'contract number',
      'project number', 'project #', 'customer reference'
    ],
    fieldType: 'text'
  },
  {
    targetField: 'accounting_document_header_text',
    sourceVariations: [
      'memo', 'notes', 'comments', 'header text', 'description',
      'invoice description', 'remarks'
    ],
    fieldType: 'text'
  }
];

/**
 * Find matching field mapping for a given key
 */
export function findFieldMapping(extractedKey: string): FieldMapping | undefined {
  const normalizedKey = extractedKey.toLowerCase().trim();
  
  return FIELD_MAPPINGS.find(mapping => 
    mapping.sourceVariations.some(variation => 
      normalizedKey.includes(variation) || variation.includes(normalizedKey)
    )
  );
}

/**
 * Get all possible source field variations for a target field
 */
export function getSourceVariations(targetField: string): string[] {
  const mapping = FIELD_MAPPINGS.find(m => m.targetField === targetField);
  return mapping?.sourceVariations || [];
}

/**
 * Apply field mappings to extracted key-value pairs
 */
export function applyFieldMappings(extractedData: Record<string, any>): {
  mapped: Record<string, any>;
  unmapped: Record<string, any>;
  mappingDetails: Array<{
    sourceKey: string;
    targetField: string;
    value: any;
    confidence: number;
  }>;
} {
  const mapped: Record<string, any> = {};
  const unmapped: Record<string, any> = {};
  const mappingDetails: Array<any> = [];

  console.log('🔍 Field Mapping Debug: Input data keys:', Object.keys(extractedData));

  // Initialize all fields with null
  FIELD_MAPPINGS.forEach(mapping => {
    mapped[mapping.targetField] = null;
  });

  // Process each extracted key-value pair
  Object.entries(extractedData).forEach(([key, value]) => {
    const mapping = findFieldMapping(key);
    console.log(`🔍 Field Mapping: "${key}" → ${mapping ? mapping.targetField : 'NO MATCH'}`);
    
    if (mapping) {
      // Apply transformation if needed
      const transformedValue = mapping.transform ? mapping.transform(value) : value;
      
      // Only map if we don't already have a value (first match wins)
      if (mapped[mapping.targetField] === null) {
        mapped[mapping.targetField] = transformedValue;
        mappingDetails.push({
          sourceKey: key,
          targetField: mapping.targetField,
          value: transformedValue,
          confidence: 0.95 // High confidence for direct mapping
        });
        console.log(`✅ Mapped: "${key}" → "${mapping.targetField}" = ${transformedValue}`);
      } else {
        console.log(`⚠️ Skipped: "${key}" → "${mapping.targetField}" (already has value: ${mapped[mapping.targetField]})`);
      }
    } else {
      // No mapping found
      unmapped[key] = value;
      console.log(`❌ Unmapped: "${key}" = ${value}`);
    }
  });

  const mappedCount = Object.values(mapped).filter(v => v !== null).length;
  console.log(`🎯 Field Mapping Results: ${mappedCount} mapped, ${Object.keys(unmapped).length} unmapped`);

  return { mapped, unmapped, mappingDetails };
}