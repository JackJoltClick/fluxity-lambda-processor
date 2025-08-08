import { createClient } from '@supabase/supabase-js';

export interface UserFieldMapping {
  id: string;
  user_id: string;
  source_key: string;
  target_field: string;
  confidence: number;
}

export class UserMappingsService {
  private supabase: any;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  /**
   * Load user's custom field mappings from database
   */
  async loadUserMappings(userId: string): Promise<UserFieldMapping[]> {
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
    } catch (error) {
      console.error('Failed to load user mappings:', error);
      return [];
    }
  }

  /**
   * Apply user's custom mappings to extracted data
   */
  applyUserMappings(
    extractedData: Record<string, any>,
    userMappings: UserFieldMapping[]
  ): {
    mapped: Record<string, any>;
    mappingDetails: Array<{
      sourceKey: string;
      targetField: string;
      value: any;
      confidence: number;
      source: string;
    }>;
  } {
    const mapped: Record<string, any> = {};
    const mappingDetails: Array<any> = [];

    // Apply each user mapping
    userMappings.forEach(mapping => {
      // Check if we have this source key in extracted data
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

  /**
   * Merge user mappings with automatic mappings
   * User mappings take precedence
   */
  mergeWithAutomaticMappings(
    automaticMappings: Record<string, any>,
    userMappings: Record<string, any>
  ): Record<string, any> {
    // Start with automatic mappings
    const merged = { ...automaticMappings };

    // Override with user mappings
    Object.entries(userMappings).forEach(([field, value]) => {
      if (value !== null && value !== undefined) {
        merged[field] = value;
      }
    });

    return merged;
  }
}