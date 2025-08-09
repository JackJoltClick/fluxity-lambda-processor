"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserMappingsService = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
class UserMappingsService {
    constructor(supabaseUrl, supabaseServiceKey) {
        this.supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey);
    }
    async loadUserMappings(userId) {
        try {
            const { data, error } = await this.supabase
                .from('user_field_mappings')
                .select('*')
                .eq('user_id', userId);
            if (error) {
                console.error('Error loading user mappings:', error);
                return [];
            }
            return data || [];
        }
        catch (error) {
            console.error('Failed to load user mappings:', error);
            return [];
        }
    }
    applyUserMappings(extractedData, userMappings) {
        const mapped = {};
        const mappingDetails = [];
        userMappings.forEach(mapping => {
            if (extractedData[mapping.source_key] !== undefined) {
                mapped[mapping.target_field] = extractedData[mapping.source_key];
                mappingDetails.push({
                    sourceKey: mapping.source_key,
                    targetField: mapping.target_field,
                    value: extractedData[mapping.source_key],
                    confidence: mapping.confidence,
                    source: 'user-mapping'
                });
            }
        });
        return { mapped, mappingDetails };
    }
    mergeWithAutomaticMappings(automaticMappings, userMappings) {
        const merged = { ...automaticMappings };
        Object.entries(userMappings).forEach(([field, value]) => {
            if (value !== null && value !== undefined) {
                merged[field] = value;
            }
        });
        return merged;
    }
}
exports.UserMappingsService = UserMappingsService;
