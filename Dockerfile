# Use AWS Lambda Node.js 18 base image
FROM public.ecr.aws/lambda/nodejs:18

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY dist/ ./

# Set the CMD to your handler
CMD ["index.handler"]