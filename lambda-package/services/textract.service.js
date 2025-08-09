"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TextractService = void 0;
const client_textract_1 = require("@aws-sdk/client-textract");
class TextractService {
    constructor() {
        this.client = new client_textract_1.TextractClient({
            region: process.env.AWS_REGION || 'us-east-1'
        });
    }
    async extractFromUrl(fileUrl) {
        try {
            console.log(`📄 Textract: Starting extraction for ${fileUrl}`);
            const response = await fetch(fileUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch document: ${response.statusText}`);
            }
            const buffer = await response.arrayBuffer();
            const document = new Uint8Array(buffer);
            const command = new client_textract_1.AnalyzeDocumentCommand({
                Document: { Bytes: document },
                FeatureTypes: [
                    client_textract_1.FeatureType.FORMS,
                    client_textract_1.FeatureType.TABLES
                ]
            });
            const result = await this.client.send(command);
            console.log(`✅ Textract: Analysis complete, processing ${result.Blocks?.length || 0} blocks`);
            return this.processTextractResponse(result);
        }
        catch (error) {
            console.error('❌ Textract extraction failed:', error);
            throw new Error(`Textract extraction failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    processTextractResponse(response) {
        const blocks = response.Blocks || [];
        const textBlocks = blocks.filter((block) => block.BlockType === client_textract_1.BlockType.LINE);
        const text = textBlocks.map((block) => block.Text).join('\n');
        const textConfidence = this.calculateAverageConfidence(textBlocks);
        const keyValuePairs = this.extractKeyValuePairs(blocks);
        const tables = this.extractTables(blocks);
        const lineItems = this.extractLineItems(tables);
        const result = {
            text,
            confidence: textConfidence,
            keyValuePairs,
            tables,
            lineItems,
            extraction_method: 'textract',
            textract_raw: response
        };
        console.log(`📊 Textract: Extracted ${Object.keys(keyValuePairs).length} key-value pairs, ${tables.length} tables, ${lineItems.length} line items`);
        console.log(`🎯 Textract: Overall confidence: ${(textConfidence * 100).toFixed(1)}%`);
        return result;
    }
    calculateAverageConfidence(blocks) {
        if (blocks.length === 0)
            return 0;
        const totalConfidence = blocks.reduce((sum, block) => {
            return sum + (block.Confidence || 0);
        }, 0);
        return totalConfidence / blocks.length / 100;
    }
    extractKeyValuePairs(blocks) {
        const keyValuePairs = {};
        const kvBlocks = blocks.filter(block => block.BlockType === client_textract_1.BlockType.KEY_VALUE_SET);
        const keyBlocks = kvBlocks.filter(block => block.EntityTypes?.includes('KEY'));
        keyBlocks.forEach(keyBlock => {
            if (!keyBlock.Relationships)
                return;
            const valueRelationship = keyBlock.Relationships.find(rel => rel.Type === 'VALUE');
            if (!valueRelationship?.Ids)
                return;
            const valueBlock = blocks.find(block => valueRelationship.Ids?.includes(block.Id || ''));
            if (valueBlock) {
                const keyText = this.getBlockText(keyBlock, blocks).trim();
                const valueText = this.getBlockText(valueBlock, blocks).trim();
                if (keyText && valueText) {
                    keyValuePairs[keyText] = valueText;
                }
            }
        });
        return keyValuePairs;
    }
    extractTables(blocks) {
        const tables = [];
        const tableBlocks = blocks.filter(block => block.BlockType === client_textract_1.BlockType.TABLE);
        tableBlocks.forEach(tableBlock => {
            if (!tableBlock.Relationships)
                return;
            const cellRelationship = tableBlock.Relationships.find(rel => rel.Type === 'CHILD');
            if (!cellRelationship?.Ids)
                return;
            const cellBlocks = blocks.filter(block => cellRelationship.Ids?.includes(block.Id || '') &&
                block.BlockType === client_textract_1.BlockType.CELL);
            const rowMap = {};
            cellBlocks.forEach(cell => {
                const rowIndex = cell.RowIndex || 0;
                const colIndex = cell.ColumnIndex || 0;
                const cellText = this.getBlockText(cell, blocks);
                if (!rowMap[rowIndex])
                    rowMap[rowIndex] = {};
                rowMap[rowIndex][colIndex] = cellText;
            });
            const rows = [];
            const sortedRowIndices = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
            sortedRowIndices.forEach(rowIndex => {
                const rowData = rowMap[rowIndex];
                const sortedColIndices = Object.keys(rowData).map(Number).sort((a, b) => a - b);
                const row = sortedColIndices.map(colIndex => rowData[colIndex] || '');
                rows.push(row);
            });
            tables.push({
                rows,
                confidence: this.calculateAverageConfidence(cellBlocks)
            });
        });
        return tables;
    }
    extractLineItems(tables) {
        const lineItems = [];
        tables.forEach(table => {
            if (table.rows.length < 2)
                return;
            const headerRow = table.rows[0];
            const dataRows = table.rows.slice(1);
            const descriptionColIndex = this.findColumnIndex(headerRow, ['description', 'item', 'product', 'service']);
            const quantityColIndex = this.findColumnIndex(headerRow, ['quantity', 'qty', 'amount']);
            const priceColIndex = this.findColumnIndex(headerRow, ['price', 'rate', 'unit price', 'cost']);
            const totalColIndex = this.findColumnIndex(headerRow, ['total', 'amount', 'line total']);
            dataRows.forEach(row => {
                if (row.some(cell => cell.trim())) {
                    const lineItem = {
                        confidence: table.confidence
                    };
                    if (descriptionColIndex >= 0 && row[descriptionColIndex]) {
                        lineItem.description = row[descriptionColIndex].trim();
                    }
                    if (quantityColIndex >= 0 && row[quantityColIndex]) {
                        lineItem.quantity = row[quantityColIndex].trim();
                    }
                    if (priceColIndex >= 0 && row[priceColIndex]) {
                        lineItem.unitPrice = row[priceColIndex].trim();
                    }
                    if (totalColIndex >= 0 && row[totalColIndex]) {
                        lineItem.amount = row[totalColIndex].trim();
                    }
                    if (lineItem.description) {
                        lineItems.push(lineItem);
                    }
                }
            });
        });
        return lineItems;
    }
    findColumnIndex(headerRow, searchTerms) {
        return headerRow.findIndex(header => searchTerms.some(term => header.toLowerCase().includes(term.toLowerCase())));
    }
    getBlockText(block, allBlocks) {
        if (block.Text) {
            return block.Text;
        }
        if (!block.Relationships)
            return '';
        const childRelationship = block.Relationships.find(rel => rel.Type === 'CHILD');
        if (!childRelationship?.Ids)
            return '';
        const childTexts = childRelationship.Ids
            .map(id => allBlocks.find(b => b.Id === id))
            .filter(b => b?.Text)
            .map(b => b.Text);
        return childTexts.join(' ');
    }
}
exports.TextractService = TextractService;
