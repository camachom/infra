#s3
resource "aws_s3_bucket" "events" {
  bucket = "${local.name}-events-${local.account_suffix}"
}

resource "aws_s3_bucket_public_access_block" "events" {
  bucket                  = aws_s3_bucket.events.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

#firehose
resource "aws_iam_role" "firehose" {
  name = "${local.name}-firehose-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "firehose.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "firehose" {
  name = "${local.name}-firehose-policy"
  role = aws_iam_role.firehose.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.events.arn,
          "${aws_s3_bucket.events.arn}/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:PutLogEvents"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_kinesis_firehose_delivery_stream" "events" {
  name        = "${local.name}-events"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose.arn
    bucket_arn = aws_s3_bucket.events.arn

    prefix              = "events/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/"
    error_output_prefix = "errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/"

    buffering_size     = 5
    buffering_interval = 60
    compression_format = "GZIP"
  }
}

#lambda
resource "aws_iam_role" "lambda" {
  name = "${local.name}-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.name}-lambda-policy"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["firehose:PutRecord", "firehose:PutRecordBatch"]
        Resource = aws_kinesis_firehose_delivery_stream.events.arn
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_lambda_function" "ingest" {
  function_name = "${local.name}-ingest"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 5
  memory_size   = 256

  # package this however you like (zip, s3, terraform archive_file, etc.)
  filename         = "./lambda.zip"
  source_code_hash = filebase64sha256("./lambda.zip")

  environment {
    variables = {
      FIREHOSE_STREAM_NAME = aws_kinesis_firehose_delivery_stream.events.name
    }
  }
}

#http
resource "aws_apigatewayv2_api" "tracker" {
  name          = "${local.name}-http-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.tracker.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingest.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "pixel" {
  api_id    = aws_apigatewayv2_api.tracker.id
  route_key = "GET /p.gif"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "event" {
  api_id    = aws_apigatewayv2_api.tracker.id
  route_key = "POST /e"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.tracker.execution_arn}/*/*"
}

resource "aws_apigatewayv2_stage" "prod" {
  api_id      = aws_apigatewayv2_api.tracker.id
  name        = "$default"
  auto_deploy = true
}

# resource "aws_apigatewayv2_api" "tracker" {
#   name          = "${var.name}-http-api"
#   protocol_type = "HTTP"

#   cors_configuration {
#     allow_origins = ["https://your-site.com"] #tb
#     allow_methods = ["POST", "OPTIONS"]
#     allow_headers = ["content-type"]
#   }
# }