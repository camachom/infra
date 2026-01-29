variable "name" {
  description = "base name for ecs resources"
  type        = string
}

variable "aws_region" {
  description = "aws region"
  type        = string
}

variable "image_tag" {
  description = "ECR image tag to deploy (repo is immutable, so this must be unique per build)"
  type        = string
}
