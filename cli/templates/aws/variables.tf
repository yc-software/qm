variable "org_id" { type = string }
variable "account_id" { type = string }
variable "region" { type = string }
variable "cluster_name" { type = string }
variable "public_url" { type = string }
variable "core_public_hosts" {
  type    = set(string)
  default = []
  validation {
    condition = alltrue([
      for host in var.core_public_hosts :
      can(regex("^(\\*\\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", host))
    ])
    error_message = "core_public_hosts entries must be normalized DNS hostnames with an optional leading wildcard"
  }
}
variable "cloud_map_namespace" { type = string }
variable "secrets_prefix" { type = string }
variable "github_repository" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository)) && var.github_repository != "replace-me/repository"
    error_message = "github_repository must be the explicit owner/name of the repository allowed to deploy"
  }
}
variable "github_subject_prefix" {
  type    = string
  default = ""
  validation {
    condition     = var.github_subject_prefix == "" || can(regex("^repo:[A-Za-z0-9_.@-]+/[A-Za-z0-9_.@-]+$", var.github_subject_prefix))
    error_message = "github_subject_prefix must be empty or an exact repo:owner/repository prefix"
  }
}
variable "github_ref" {
  type = string
  validation {
    condition     = can(regex("^refs/heads/[^[:space:]]+$", var.github_ref))
    error_message = "github_ref must be an explicit refs/heads/* branch"
  }
}
variable "github_environment" {
  type    = string
  default = ""
  validation {
    condition     = var.github_environment == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*$", var.github_environment))
    error_message = "github_environment must be empty or a supported GitHub environment name"
  }
}
variable "github_oidc_provider_arn" { type = string }
variable "object_store_bucket" { type = string }
variable "transfer_lifecycle_prefix" { type = string }
variable "deploy_microvm_image" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", var.deploy_microvm_image))
    error_message = "deploy_microvm_image must be a stack-owned Lambda MicroVM image name"
  }
}
variable "deploy_microvm_execution_role_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::${var.account_id}:role/[A-Za-z0-9_+=,.@/-]+$", var.deploy_microvm_execution_role_arn))
    error_message = "deploy_microvm_execution_role_arn must be an IAM role in the configured AWS account"
  }
}
variable "certificate_arn" {
  type    = string
  default = ""
  validation {
    condition     = var.certificate_arn == "" || can(regex("^arn:(aws|aws-us-gov|aws-cn):acm:[a-z0-9-]+:[0-9]{12}:certificate/[0-9a-f-]+$", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN in the configured AWS partition"
  }
}
check "split_core_hosts_require_direct_tls" {
  assert {
    condition     = length(var.core_public_hosts) == 0 || var.certificate_arn != ""
    error_message = "core_public_hosts requires certificate_arn because split host routing uses the public HTTPS ALB instead of the default CloudFront hostname"
  }
}
variable "db_name" {
  type    = string
  default = "qm"
}
variable "db_username" {
  type    = string
  default = "qm"
}
variable "db_backup_retention_days" {
  type    = number
  default = 35
  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 1 and 35"
  }
}
variable "db_multi_az" {
  type    = bool
  default = false
}
variable "db_skip_final_snapshot" {
  type    = bool
  default = false
}
variable "ecr_force_delete" {
  type    = bool
  default = false
}
variable "ecs_blue_green_bake_minutes" {
  type    = number
  default = 5
  validation {
    condition     = var.ecs_blue_green_bake_minutes >= 0 && var.ecs_blue_green_bake_minutes <= 1440
    error_message = "ecs_blue_green_bake_minutes must be between 0 and 1440"
  }
}
variable "object_store_force_destroy" {
  type    = bool
  default = false
}
variable "secret_recovery_window_days" {
  type    = number
  default = 7
  validation {
    condition     = var.secret_recovery_window_days == 0 || (var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 30)
    error_message = "secret_recovery_window_days must be 0 or between 7 and 30"
  }
}
variable "services" {
  type = map(object({
    ecr_repository     = string
    ecs_service        = string
    cpu                = number
    memory             = number
    architecture       = string
    internal_port      = number
    task_role_arn      = optional(string)
    execution_role_arn = optional(string)
    assume_role_arns   = optional(set(string))
    manage_task_role   = optional(bool, false)
    public_paths       = optional(list(string), [])
  }))
}
variable "secret_names" { type = set(string) }
