#!/bin/bash

# Deploy CloudFormation stack for Fluxity Lambda Processor
# Usage: ./deploy.sh [environment] [supabase-url] [supabase-key] [openai-key]

set -e

ENVIRONMENT=${1:-production}
SUPABASE_URL=${2:-$SUPABASE_URL}
SUPABASE_SERVICE_KEY=${3:-$SUPABASE_SERVICE_KEY}
OPENAI_API_KEY=${4:-$OPENAI_API_KEY}
AWS_REGION=${AWS_REGION:-us-west-2}
STACK_NAME="fluxity-lambda-processor-${ENVIRONMENT}"

echo "🚀 Deploying Fluxity Lambda Processor infrastructure..."
echo "Environment: $ENVIRONMENT"
echo "Region: $AWS_REGION"
echo "Stack: $STACK_NAME"

# Validate required parameters
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ] || [ -z "$OPENAI_API_KEY" ]; then
    echo "❌ Error: Missing required environment variables"
    echo "Required: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY"
    exit 1
fi

# Deploy CloudFormation stack
aws cloudformation deploy \
    --template-file cloudformation.yml \
    --stack-name "$STACK_NAME" \
    --parameter-overrides \
        Environment="$ENVIRONMENT" \
        SupabaseUrl="$SUPABASE_URL" \
        SupabaseServiceKey="$SUPABASE_SERVICE_KEY" \
        OpenAIApiKey="$OPENAI_API_KEY" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "$AWS_REGION" \
    --no-fail-on-empty-changeset

echo "✅ Infrastructure deployment complete!"

# Get stack outputs
echo "📋 Stack outputs:"
aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
    --output table

echo ""
echo "🔗 Next steps:"
echo "1. Push code to GitHub to trigger Lambda deployment"
echo "2. Update your main app's SQS_QUEUE_URL environment variable"
echo "3. Test document upload and processing"