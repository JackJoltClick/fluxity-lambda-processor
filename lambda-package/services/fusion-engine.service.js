"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FusionEngine = void 0;
const field_mappings_1 = require("../config/field-mappings");
class FusionEngine {
    async combine(textractResult, openaiResult) {
        console.log('🔄 Fusion: Starting hybrid analysis...');
        console.log('🔍 Fusion: Textract key-value pairs:', Object.keys(textractResult.keyValuePairs));
        const fieldMappings = (0, field_mappings_1.applyFieldMappings)(textractResult.keyValuePairs);
        console.log(`📋 Direct mapping: ${Object.keys(fieldMappings.mapped).filter(k => fieldMappings.mapped[k] !== null).length} fields mapped`);
        console.log(`❓ Unmapped fields: ${Object.keys(fieldMappings.unmapped).length}`);
        console.log('📋 Mapped fields:', Object.entries(fieldMappings.mapped).filter(([k, v]) => v !== null).map(([k, v]) => `${k}=${v}`));
        const mappingTrail = fieldMappings.mappingDetails.map(detail => ({
            sourceKey: detail.sourceKey,
            sourceValue: textractResult.keyValuePairs[detail.sourceKey],
            targetField: detail.targetField,
            mappedValue: detail.value,
            confidence: detail.confidence,
            method: 'textract-direct'
        }));
        const crossValidation = this.performCrossValidation(textractResult, openaiResult, fieldMappings);
        const hybridConfidence = this.calculateHybridConfidence(textractResult.confidence, openaiResult.confidence, crossValidation.agreementScore);
        const combinedText = this.combineText(textractResult.text, openaiResult.text);
        const businessLogic = this.extractBusinessLogic(openaiResult);
        const mergedAccountingFields = this.mergeAccountingFields(fieldMappings.mapped, businessLogic.accounting_fields || {});
        businessLogic.accounting_fields = mergedAccountingFields;
        const textractCost = this.calculateTextractCost(textractResult);
        const openaiCost = openaiResult.total_cost || 0;
        const result = {
            text: combinedText,
            confidence: hybridConfidence,
            keyValuePairs: textractResult.keyValuePairs,
            tables: textractResult.tables,
            lineItems: textractResult.lineItems,
            businessLogic,
            normalizedData: this.normalizeData(textractResult, openaiResult),
            fieldMappings: {
                mapped: fieldMappings.mapped,
                unmapped: fieldMappings.unmapped,
                mappingDetails: fieldMappings.mappingDetails,
                mappingTrail
            },
            crossValidation,
            extraction_method: 'hybrid',
            textract_confidence: textractResult.confidence,
            openai_confidence: openaiResult.confidence,
            total_cost: textractCost + openaiCost,
            textract_cost: textractCost,
            openai_cost: openaiCost,
            textract_raw: textractResult.textract_raw,
            openai_raw: openaiResult.extracted_data || openaiResult
        };
        console.log(`✅ Fusion: Hybrid analysis complete`);
        console.log(`🎯 Fusion: Combined confidence: ${(hybridConfidence * 100).toFixed(1)}%`);
        console.log(`🤝 Fusion: Agreement score: ${(crossValidation.agreementScore * 100).toFixed(1)}%`);
        console.log(`💰 Fusion: Total cost: $${result.total_cost.toFixed(4)}`);
        return result;
    }
    mergeAccountingFields(directMapped, openaiFields) {
        const merged = {};
        const allFields = new Set([
            ...Object.keys(directMapped),
            ...Object.keys(openaiFields)
        ]);
        allFields.forEach(field => {
            const directValue = directMapped[field];
            const openaiValue = openaiFields[field]?.value || openaiFields[field];
            if (directValue !== null && directValue !== undefined) {
                merged[field] = {
                    value: directValue,
                    confidence: 0.95,
                    source: 'direct-mapping'
                };
            }
            else if (openaiValue !== null && openaiValue !== undefined) {
                merged[field] = {
                    value: openaiValue,
                    confidence: openaiFields[field]?.confidence || 0.8,
                    source: 'openai'
                };
            }
            else {
                merged[field] = {
                    value: null,
                    confidence: 0,
                    source: 'none'
                };
            }
        });
        return merged;
    }
    performCrossValidation(textractResult, openaiResult, fieldMappings) {
        const validatedFields = {};
        const conflictingFields = [];
        const commonFields = [
            'invoice_number', 'invoice_date', 'due_date', 'vendor_name',
            'total_amount', 'subtotal', 'tax_amount', 'currency'
        ];
        let agreements = 0;
        let totalComparisons = 0;
        commonFields.forEach(fieldName => {
            const textractValue = this.extractFieldFromTextract(fieldName, textractResult);
            const openaiValue = this.extractFieldFromOpenAI(fieldName, openaiResult);
            if (textractValue || openaiValue) {
                totalComparisons++;
                const isMatch = this.fieldsMatch(textractValue, openaiValue, fieldName);
                if (isMatch) {
                    agreements++;
                    validatedFields[fieldName] = {
                        textractValue,
                        openaiValue,
                        finalValue: textractValue || openaiValue,
                        confidence: 0.95,
                        source: 'consensus'
                    };
                }
                else {
                    conflictingFields.push(fieldName);
                    const textractConfidence = this.getFieldConfidence(fieldName, textractResult);
                    const openaiConfidence = this.getFieldConfidence(fieldName, openaiResult);
                    if (textractConfidence > openaiConfidence) {
                        validatedFields[fieldName] = {
                            textractValue,
                            openaiValue,
                            finalValue: textractValue,
                            confidence: textractConfidence * 0.8,
                            source: 'textract'
                        };
                    }
                    else {
                        validatedFields[fieldName] = {
                            textractValue,
                            openaiValue,
                            finalValue: openaiValue,
                            confidence: openaiConfidence * 0.8,
                            source: 'openai'
                        };
                    }
                }
            }
        });
        const agreementScore = totalComparisons > 0 ? agreements / totalComparisons : 0.5;
        return {
            agreementScore,
            conflictingFields,
            validatedFields
        };
    }
    calculateHybridConfidence(textractConf, openaiConf, agreementScore) {
        const baseConfidence = (textractConf * 0.6) + (openaiConf * 0.4);
        const agreementBonus = agreementScore * 0.1;
        return Math.min(baseConfidence + agreementBonus, 1.0);
    }
    combineText(textractText, openaiText) {
        return textractText || openaiText;
    }
    extractBusinessLogic(openaiResult) {
        if (openaiResult.extracted_data) {
            return {
                accounting_fields: openaiResult.extracted_data.accounting_fields || {},
                businessRules: openaiResult.extracted_data.business_rules || {},
                interpretations: openaiResult.extracted_data.interpretations || {},
                normalizations: openaiResult.extracted_data.normalizations || {}
            };
        }
        return { accounting_fields: {} };
    }
    normalizeData(textractResult, openaiResult) {
        return {
            tables: textractResult.tables,
            keyValuePairs: textractResult.keyValuePairs,
            businessContext: openaiResult.extracted_data || {},
            enhancedLineItems: this.enhanceLineItems(textractResult.lineItems, openaiResult)
        };
    }
    enhanceLineItems(textractLineItems, openaiResult) {
        return textractLineItems.map(item => ({
            ...item,
            businessCategory: this.categorizeLineItem(item.description, openaiResult),
            normalizedAmount: this.normalizeAmount(item.amount),
            glAccountSuggestion: this.suggestGLAccount(item, openaiResult)
        }));
    }
    categorizeLineItem(description, openaiResult) {
        const extracted = openaiResult.extracted_data;
        if (extracted?.line_items) {
            const matchingItem = extracted.line_items.find((item) => item.description?.toLowerCase().includes(description?.toLowerCase()));
            return matchingItem?.category;
        }
        return undefined;
    }
    normalizeAmount(amount) {
        if (!amount)
            return undefined;
        const cleanAmount = amount.replace(/[^\d.,]/g, '');
        const normalized = parseFloat(cleanAmount.replace(',', ''));
        return isNaN(normalized) ? undefined : normalized;
    }
    suggestGLAccount(item, openaiResult) {
        const extracted = openaiResult.extracted_data;
        return extracted?.gl_suggestions?.[item.description] || undefined;
    }
    extractFieldFromTextract(fieldName, result) {
        const fieldMappings = {
            'invoice_number': ['Invoice Number', 'Invoice #', 'Number', 'Doc Number'],
            'invoice_date': ['Invoice Date', 'Date', 'Issue Date'],
            'due_date': ['Due Date', 'Payment Due'],
            'vendor_name': ['Vendor', 'Company', 'From', 'Supplier'],
            'total_amount': ['Total', 'Amount Due', 'Grand Total'],
            'subtotal': ['Subtotal', 'Sub Total'],
            'tax_amount': ['Tax', 'Sales Tax', 'VAT'],
            'currency': ['Currency', 'CCY']
        };
        const possibleKeys = fieldMappings[fieldName] || [fieldName];
        for (const key of possibleKeys) {
            for (const [kvKey, kvValue] of Object.entries(result.keyValuePairs)) {
                if (kvKey.toLowerCase().includes(key.toLowerCase())) {
                    return kvValue;
                }
            }
        }
        return null;
    }
    extractFieldFromOpenAI(fieldName, result) {
        const extracted = result.extracted_data;
        if (!extracted)
            return null;
        if (extracted[fieldName])
            return extracted[fieldName];
        const variations = [
            fieldName.replace('_', ' '),
            fieldName.replace('_', ''),
            fieldName.toLowerCase(),
            fieldName.toUpperCase()
        ];
        for (const variation of variations) {
            if (extracted[variation])
                return extracted[variation];
        }
        return null;
    }
    fieldsMatch(value1, value2, fieldType) {
        if (!value1 || !value2)
            return false;
        switch (fieldType) {
            case 'invoice_date':
            case 'due_date':
                return this.datesMatch(value1, value2);
            case 'total_amount':
            case 'subtotal':
            case 'tax_amount':
                return this.amountsMatch(value1, value2);
            default:
                return this.stringsMatch(value1, value2);
        }
    }
    datesMatch(date1, date2) {
        const normalized1 = new Date(date1).toISOString().split('T')[0];
        const normalized2 = new Date(date2).toISOString().split('T')[0];
        return normalized1 === normalized2;
    }
    amountsMatch(amount1, amount2) {
        const num1 = this.normalizeAmount(amount1);
        const num2 = this.normalizeAmount(amount2);
        if (!num1 || !num2)
            return false;
        const difference = Math.abs(num1 - num2);
        const average = (num1 + num2) / 2;
        return difference / average < 0.01;
    }
    stringsMatch(str1, str2) {
        const clean1 = str1.toLowerCase().trim();
        const clean2 = str2.toLowerCase().trim();
        return clean1 === clean2 ||
            clean1.includes(clean2) ||
            clean2.includes(clean1);
    }
    getFieldConfidence(fieldName, result) {
        if ('textract_raw' in result) {
            return result.confidence;
        }
        else {
            return result.confidence || 0.8;
        }
    }
    calculateTextractCost(result) {
        return 0.065;
    }
}
exports.FusionEngine = FusionEngine;
