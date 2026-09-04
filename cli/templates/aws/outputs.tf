output "alb_hostname" { value = aws_lb.this.dns_name }
output "cloudfront_hostname" { value = aws_cloudfront_distribution.portal.domain_name }
output "cluster" { value = aws_ecs_cluster.this.name }
output "deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "task_execution_role_arn" { value = aws_iam_role.task_execution.arn }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "core_task_role_arn" { value = aws_iam_role.core_task.arn }
output "microvm_build_role_arn" { value = aws_iam_role.microvm_build.arn }
output "microvm_execution_role_arn" { value = var.deploy_microvm_execution_role_arn }
output "object_store_bucket" { value = aws_s3_bucket.objects.bucket }
output "core_object_store_environment" {
  value = {
    SNAPSHOT_STORE = "s3"
    TRANSFER_STORE = "s3"
    S3_BUCKET      = aws_s3_bucket.objects.bucket
    S3_REGION      = var.region
  }
}
