variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-west-1"
}

variable "name" {
  description = "Name prefix for resources"
  type        = string
  default     = "redirect-security-toy"
}
