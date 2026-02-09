provider "aws" {
  region  = var.aws_region
  profile = "personal"
}

data "aws_caller_identity" "current" {}

locals {
  name           = var.name
  account_id     = data.aws_caller_identity.current.account_id
  account_suffix = substr(local.account_id, length(local.account_id) - 4, 4)
}