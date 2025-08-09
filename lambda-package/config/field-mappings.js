"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIELD_MAPPINGS = void 0;
exports.findFieldMapping = findFieldMapping;
exports.getSourceVariations = getSourceVariations;
exports.applyFieldMappings = applyFieldMappings;
const parseDate = (value) => {
    try {
        const date = new Date(value);
        return date.toISOString().split('T')[0];
    }
    catch {
        return value;
    }
};
const parseAmount = (value) => {
    const cleaned = value.replace(/[^0-9.-]/g, '');
    return parseFloat(cleaned) || 0;
};
exports.FIELD_MAPPINGS = [
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
function findFieldMapping(extractedKey) {
    const normalizedKey = extractedKey.toLowerCase().trim();
    return exports.FIELD_MAPPINGS.find(mapping => mapping.sourceVariations.some(variation => normalizedKey.includes(variation) || variation.includes(normalizedKey)));
}
function getSourceVariations(targetField) {
    const mapping = exports.FIELD_MAPPINGS.find(m => m.targetField === targetField);
    return mapping?.sourceVariations || [];
}
function applyFieldMappings(extractedData) {
    const mapped = {};
    const unmapped = {};
    const mappingDetails = [];
    console.log('🔍 Field Mapping Debug: Input data keys:', Object.keys(extractedData));
    exports.FIELD_MAPPINGS.forEach(mapping => {
        mapped[mapping.targetField] = null;
    });
    Object.entries(extractedData).forEach(([key, value]) => {
        const mapping = findFieldMapping(key);
        console.log(`🔍 Field Mapping: "${key}" → ${mapping ? mapping.targetField : 'NO MATCH'}`);
        if (mapping) {
            const transformedValue = mapping.transform ? mapping.transform(value) : value;
            if (mapped[mapping.targetField] === null) {
                mapped[mapping.targetField] = transformedValue;
                mappingDetails.push({
                    sourceKey: key,
                    targetField: mapping.targetField,
                    value: transformedValue,
                    confidence: 0.95
                });
                console.log(`✅ Mapped: "${key}" → "${mapping.targetField}" = ${transformedValue}`);
            }
            else {
                console.log(`⚠️ Skipped: "${key}" → "${mapping.targetField}" (already has value: ${mapped[mapping.targetField]})`);
            }
        }
        else {
            unmapped[key] = value;
            console.log(`❌ Unmapped: "${key}" = ${value}`);
        }
    });
    const mappedCount = Object.values(mapped).filter(v => v !== null).length;
    console.log(`🎯 Field Mapping Results: ${mappedCount} mapped, ${Object.keys(unmapped).length} unmapped`);
    return { mapped, unmapped, mappingDetails };
}
