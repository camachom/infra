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

#kinesis
resource "aws_kinesis_stream" "events" {
  name             = "${local.name}-events"
  shard_count      = 1
  retention_period = 24

  stream_mode_details {
    stream_mode = "PROVISIONED"
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
        Action   = ["kinesis:PutRecord"]
        Resource = aws_kinesis_stream.events.arn
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
  runtime       = "nodejs24.x"
  timeout       = 5
  memory_size   = 256

  # package this however you like (zip, s3, terraform archive_file, etc.)
  filename         = "./lambda.zip"
  source_code_hash = filebase64sha256("./lambda.zip")

  environment {
    variables = {
      KINESIS_STREAM_NAME = aws_kinesis_stream.events.name
    }
  }
}

#lambda-consumer
resource "aws_iam_role" "lambda_consumer" {
  name = "${local.name}-lambda-consumer-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda_consumer" {
  name = "${local.name}-lambda-consumer-policy"
  role = aws_iam_role.lambda_consumer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:ListShards"]
        Resource = aws_kinesis_stream.events.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.events.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:BatchWriteItem"]
        Resource = aws_dynamodb_table.stats.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_lambda_function" "consumer" {
  function_name    = "${local.name}-consumer"
  role             = aws_iam_role.lambda_consumer.arn
  handler          = "consumer.handler"
  runtime          = "nodejs24.x"
  timeout          = 60
  memory_size      = 256
  filename         = "./lambda.zip"
  source_code_hash = filebase64sha256("./lambda.zip")

  environment {
    variables = {
      S3_BUCKET      = aws_s3_bucket.events.id
      DYNAMODB_TABLE = aws_dynamodb_table.stats.name
    }
  }
}

resource "aws_lambda_event_source_mapping" "kinesis" {
  event_source_arn                   = aws_kinesis_stream.events.arn
  function_name                      = aws_lambda_function.consumer.arn
  starting_position                  = "LATEST"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 5
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

  default_route_settings {
    throttling_burst_limit = 2000
    throttling_rate_limit  = 1000
  }
}

#dynamodb
resource "aws_dynamodb_table" "stats" {
  name         = "${local.name}-stats"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

#lambda2
resource "aws_iam_role" "lambda-dashboard" {
  name = "${local.name}-lambda-dashboard-role"
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

resource "aws_iam_role_policy" "lambda-dashboard" {
  name = "${local.name}-lambda-dashboard-policy"
  role = aws_iam_role.lambda-dashboard.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:GetItem"
        ],
        Resource = aws_dynamodb_table.stats.arn
      }
    ]
  })
}

resource "aws_lambda_function" "dashboard" {
  function_name = "${local.name}-dashboard"
  role          = aws_iam_role.lambda-dashboard.arn
  handler       = "dashboard.handler"
  runtime       = "nodejs24.x"
  timeout       = 5
  memory_size   = 256

  # package this however you like (zip, s3, terraform archive_file, etc.)
  filename         = "./lambda.zip"
  source_code_hash = filebase64sha256("./lambda.zip")

  environment {
    variables = {
      API_ENDPOINT   = aws_apigatewayv2_api.tracker.api_endpoint
      DYNAMODB_TABLE = aws_dynamodb_table.stats.name
    }
  }
}

resource "aws_apigatewayv2_integration" "lambda-dashboard" {
  api_id                 = aws_apigatewayv2_api.tracker.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.dashboard.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "dashboard-index" {
  api_id    = aws_apigatewayv2_api.tracker.id
  route_key = "GET /"
  target    = "integrations/${aws_apigatewayv2_integration.lambda-dashboard.id}"
}

resource "aws_apigatewayv2_route" "demo" {
  api_id    = aws_apigatewayv2_api.tracker.id
  route_key = "GET /demo"
  target    = "integrations/${aws_apigatewayv2_integration.lambda-dashboard.id}"
}

resource "aws_apigatewayv2_route" "dashboard" {
  api_id    = aws_apigatewayv2_api.tracker.id
  route_key = "GET /dashboard"
  target    = "integrations/${aws_apigatewayv2_integration.lambda-dashboard.id}"
}

resource "aws_apigatewayv2_route" "stats" {
  api_id    = aws_apigatewayv2_api.tracker.id
  route_key = "GET /api/stats"
  target    = "integrations/${aws_apigatewayv2_integration.lambda-dashboard.id}"
}

resource "aws_lambda_permission" "apigw_dashboard" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dashboard.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.tracker.execution_arn}/*/*"
}