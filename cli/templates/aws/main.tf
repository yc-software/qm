locals {
  tags                       = { Deployment = var.org_id, ManagedBy = "terraform" }
  azs                        = length(data.aws_availability_zones.available.names) >= 2 ? slice(data.aws_availability_zones.available.names, 0, 2) : []
  subnet_ids                 = values(aws_subnet.public)[*].id
  vpc_id                     = aws_vpc.this.id
  has_portal                 = contains(keys(var.services), "portal")
  public_service_names       = local.has_portal ? ["portal"] : ["core"]
  ingress_services           = { for name, service in var.services : name => service if contains(local.public_service_names, name) }
  direct_path_services       = local.has_portal ? {} : { core = ["/v1/*"] }
  alb_name                   = "${substr(var.cluster_name, 0, 23)}-${substr(sha1(var.cluster_name), 0, 8)}"
  service_security_groups    = [aws_security_group.services.id]
  default_task_role_arn      = aws_iam_role.task.arn
  core_task_role_arn         = aws_iam_role.core_task.arn
  default_execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arns = distinct(compact(concat(
    [local.default_task_role_arn, local.core_task_role_arn],
    [for service in values(var.services) : service.task_role_arn],
  )))
  execution_role_arns = distinct(compact(concat(
    [local.default_execution_role_arn],
    [for service in values(var.services) : service.execution_role_arn],
  )))
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }
data "aws_iam_openid_connect_provider" "github" { arn = var.github_oidc_provider_arn }
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_vpc" "this" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.cluster_name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = local.tags
}

resource "aws_subnet" "public" {
  for_each                = toset(local.azs)
  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.value
  cidr_block              = cidrsubnet(aws_vpc.this.cidr_block, 8, index(local.azs, each.value))
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${var.cluster_name}-${each.value}" })
}

check "two_availability_zones" {
  assert {
    condition     = length(data.aws_availability_zones.available.names) >= 2
    error_message = "the configured AWS region must expose at least two available availability zones"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = local.tags
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name   = "${var.cluster_name}-alb"
  vpc_id = local.vpc_id
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_security_group" "services" {
  name   = "${var.cluster_name}-services"
  vpc_id = local.vpc_id
  dynamic "ingress" {
    for_each = toset([for service in values(local.ingress_services) : tostring(service.internal_port)])
    content {
      from_port       = tonumber(ingress.value)
      to_port         = tonumber(ingress.value)
      protocol        = "tcp"
      security_groups = [aws_security_group.alb.id]
    }
  }
  dynamic "ingress" {
    for_each = toset([for service in values(var.services) : tostring(service.internal_port)])
    content {
      from_port = tonumber(ingress.value)
      to_port   = tonumber(ingress.value)
      protocol  = "tcp"
      self      = true
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = var.cluster_name
  tags = local.tags
}
resource "aws_ecr_repository" "service" {
  for_each     = var.services
  name         = each.value.ecr_repository
  force_delete = var.ecr_force_delete
  image_scanning_configuration { scan_on_push = true }
  tags = local.tags
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = var.cloud_map_namespace
  vpc  = aws_vpc.this.id
  tags = local.tags
}

resource "aws_service_discovery_service" "service" {
  for_each = var.services
  name     = each.key
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
  tags = local.tags
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.cluster_name}-task-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_secrets" {
  role   = aws_iam_role.task_execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [for secret in aws_secretsmanager_secret.contract : secret.arn] }] })
}

resource "aws_iam_role" "task" {
  name               = "${var.cluster_name}-task"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = local.tags
}

resource "aws_iam_role" "core_task" {
  name               = "${var.cluster_name}-core-task"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = local.tags
}

resource "aws_cloudwatch_log_group" "microvm" {
  name              = "/aws/lambda/microvms/${var.deploy_microvm_image}"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_iam_role" "microvm_build" {
  name               = "${var.cluster_name}-microvm-build"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"] }] })
  tags               = local.tags
}

resource "aws_iam_role_policy" "microvm_build" {
  role = aws_iam_role.microvm_build.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.objects.arn}/deployment/microvm-images/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup"]
        Resource = aws_cloudwatch_log_group.microvm.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.microvm.arn}:*"
      }
    ]
  })
}

resource "aws_iam_role" "microvm_execution" {
  name               = "${var.cluster_name}-microvm-exec"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"] }] })
  tags               = local.tags
}

resource "aws_iam_role_policy" "microvm_execution" {
  role = aws_iam_role.microvm_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup"]
        Resource = aws_cloudwatch_log_group.microvm.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.microvm.arn}:*"
      }
    ]
  })
}

resource "aws_iam_role" "github_deploy" {
  name = "${var.cluster_name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # The branch subject stays even when an environment is configured: workflows that deploy
          # from main without declaring one assume this same role.
          "token.actions.githubusercontent.com:sub" = compact([
            var.github_environment != "" ? "repo:${var.github_repository}:environment:${var.github_environment}" : "",
            "repo:${var.github_repository}:ref:${var.github_ref}",
          ])
        }
      }
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "github_deploy" {
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "GlobalReads"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecs:DescribeTaskDefinition",
          "ecs:ListTaskDefinitions",
          "ec2:DescribeSecurityGroups",
          "elasticloadbalancing:Describe*",
          "rds:DescribeDBInstances",
          "rds:DescribeDBSnapshots",
          "servicediscovery:ListNamespaces",
          "servicediscovery:ListServices",
          "logs:DescribeLogGroups"
        ]
        Resource = "*"
      },
      {
        Sid    = "CreatePredeployDatabaseSnapshots"
        Effect = "Allow"
        Action = "rds:CreateDBSnapshot"
        Resource = [
          aws_db_instance.this.arn,
          "arn:aws:rds:${var.region}:${data.aws_caller_identity.current.account_id}:snapshot:${aws_db_instance.this.identifier}-predeploy-*"
        ]
      },
      {
        Sid    = "ManagePredeployDatabaseSnapshots"
        Effect = "Allow"
        Action = [
          "rds:AddTagsToResource",
          "rds:DeleteDBSnapshot"
        ]
        Resource = "arn:aws:rds:${var.region}:${data.aws_caller_identity.current.account_id}:snapshot:${aws_db_instance.this.identifier}-predeploy-*"
      },
      {
        Sid    = "ManageStackTaskDefinitions"
        Effect = "Allow"
        Action = [
          "ecs:ListTagsForResource",
          "ecs:RegisterTaskDefinition",
          "ecs:TagResource"
        ]
        Resource = [for service in values(var.services) : "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${service.ecs_service}:*"]
      },
      {
        Sid    = "PushDeploymentImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchDeleteImage",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage"
        ]
        Resource = [for repository in aws_ecr_repository.service : repository.arn]
      },
      {
        Sid      = "DescribeCluster"
        Effect   = "Allow"
        Action   = ["ecs:DescribeClusters"]
        Resource = [aws_ecs_cluster.this.arn]
      },
      {
        Sid      = "RollClusterServices"
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:ListTagsForResource", "ecs:UpdateService"]
        Resource = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:service/${var.cluster_name}/*"]
      },
      {
        Sid       = "PassTaskRolesToEcs"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = concat(local.execution_role_arns, local.task_role_arns)
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Sid      = "InspectDeployRoles"
        Effect   = "Allow"
        Action   = ["iam:GetRole"]
        Resource = [aws_iam_role.github_deploy.arn, aws_iam_role.task_execution.arn, aws_iam_role.task.arn, aws_iam_role.core_task.arn, aws_iam_role.microvm_build.arn, var.deploy_microvm_execution_role_arn]
      },
      {
        Sid    = "ManageStackMicrovmImage"
        Effect = "Allow"
        Action = [
          "lambda:GetMicrovmImage",
          "lambda:GetMicrovmImageVersion",
          "lambda:ListTags",
          "lambda:ListMicrovmImageVersions",
          "lambda:UpdateMicrovmImage",
          "lambda:DeleteMicrovmImage",
          "lambda:DeleteMicrovmImageVersion",
          "lambda:TerminateMicrovm",
          "lambda:TagResource"
        ]
        Resource = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:microvm-image:${var.deploy_microvm_image}"
      },
      {
        Sid      = "ListMicrovmResources"
        Effect   = "Allow"
        Action   = ["lambda:ListMicrovmImages", "lambda:ListMicrovms"]
        Resource = "*"
      },
      {
        Sid      = "CreateStackMicrovmImage"
        Effect   = "Allow"
        Action   = ["lambda:CreateMicrovmImage"]
        Resource = "*"
      },
      {
        Sid       = "PassMicrovmBuildRole"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = aws_iam_role.microvm_build.arn
        Condition = { StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" } }
      },
      {
        Sid      = "InspectGithubOidcProvider"
        Effect   = "Allow"
        Action   = ["iam:GetOpenIDConnectProvider"]
        Resource = [data.aws_iam_openid_connect_provider.github.arn]
      },
      {
        Sid    = "ManageContractSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue"
        ]
        Resource = [for secret in aws_secretsmanager_secret.contract : secret.arn]
      },
      {
        Sid      = "TailServiceLogs"
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams", "logs:StartLiveTail"]
        Resource = concat([for group in aws_cloudwatch_log_group.service : group.arn], [for group in aws_cloudwatch_log_group.service : "${group.arn}:*"])
      },
      {
        Sid      = "DeployLease"
        Effect   = "Allow"
        Action   = ["dynamodb:ConditionCheckItem", "dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = [aws_dynamodb_table.deploy_locks.arn]
      },
      {
        Sid      = "InspectObjectStore"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:ListBucketVersions"]
        Resource = [aws_s3_bucket.objects.arn]
        Condition = {
          StringLike = { "s3:prefix" = ["deployment/*"] }
        }
      },
      {
        Sid      = "ManageDeploymentLayers"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${aws_s3_bucket.objects.arn}/deployment/layers/*"]
      },
      {
        Sid      = "ManageMicrovmBuildArtifacts"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = ["${aws_s3_bucket.objects.arn}/deployment/microvm-images/*"]
      }
    ]
  })
}

resource "aws_dynamodb_table" "deploy_locks" {
  name         = "${var.cluster_name}-deploy-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "lockKey"
  attribute {
    name = "lockKey"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  tags = local.tags
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "random_id" "final_snapshot" {
  byte_length = 4
  keepers = {
    database_identifier = "${var.cluster_name}-core"
  }
}

resource "aws_db_subnet_group" "this" {
  name       = var.cluster_name
  subnet_ids = local.subnet_ids
  tags       = local.tags
}
resource "aws_security_group" "database" {
  name   = "${var.cluster_name}-database"
  vpc_id = aws_vpc.this.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = local.service_security_groups
  }
  tags = local.tags
}

resource "aws_db_instance" "this" {
  identifier                = "${var.cluster_name}-core"
  engine                    = "postgres"
  engine_version            = "16"
  instance_class            = "db.t4g.small"
  allocated_storage         = 20
  db_name                   = var.db_name
  username                  = var.db_username
  password                  = random_password.database.result
  db_subnet_group_name      = aws_db_subnet_group.this.name
  vpc_security_group_ids    = [aws_security_group.database.id]
  storage_encrypted         = true
  backup_retention_period   = var.db_backup_retention_days
  multi_az                  = var.db_multi_az
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_skip_final_snapshot ? null : "${var.cluster_name}-final-${random_id.final_snapshot.hex}"
  tags                      = local.tags
}

resource "aws_s3_bucket" "objects" {
  bucket        = var.object_store_bucket
  force_destroy = var.object_store_force_destroy
  tags          = local.tags
}

resource "aws_s3_bucket_policy" "objects" {
  bucket = aws_s3_bucket.objects.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.objects.arn, "${aws_s3_bucket.objects.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyCrossAccount"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.objects.arn, "${aws_s3_bucket.objects.arn}/*"]
        Condition = { StringNotEquals = { "aws:PrincipalAccount" = data.aws_caller_identity.current.account_id } }
      },
    ]
  })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "objects" {
  bucket = aws_s3_bucket.objects.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "objects" {
  bucket     = aws_s3_bucket.objects.id
  depends_on = [aws_s3_bucket_versioning.objects]

  rule {
    id     = "qm-version-cleanup"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    expiration {
      expired_object_delete_marker = true
    }

  }

  rule {
    id     = "qm-transfer-expiry"
    status = "Enabled"

    filter {
      prefix = var.transfer_lifecycle_prefix
    }

    expiration {
      days = 1
    }

    # Keep this identical to the rule written by the core's ensureExpiry.
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_iam_role_policy" "task_objects" {
  role = aws_iam_role.core_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:GetLifecycleConfiguration",
          "s3:PutLifecycleConfiguration"
        ]
        Resource = aws_s3_bucket.objects.arn
      },
      {
        Effect   = "Allow"
        # AbortMultipartUpload is its own action — PutObject covers Create/UploadPart/Complete but
        # not the abort, and without it a failed staging upload strands parts that bill silently.
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
        Resource = "${aws_s3_bucket.objects.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:GetTaskProtection", "ecs:UpdateTaskProtection"]
        Resource = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task/${var.cluster_name}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "lambda:RunMicrovm",
          "lambda:GetMicrovm",
          "lambda:SuspendMicrovm",
          "lambda:ResumeMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:CreateMicrovmAuthToken"
        ]
        Resource = [
          "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:microvm-image:${var.deploy_microvm_image}"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = var.deploy_microvm_execution_role_arn
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:PassNetworkConnector"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:ListMicrovmImages"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_secretsmanager_secret" "contract" {
  for_each                = var.secret_names
  name                    = "${var.secrets_prefix}${each.value}"
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}
resource "aws_secretsmanager_secret_version" "database" {
  count         = contains(var.secret_names, "DATABASE_URL") ? 1 : 0
  secret_id     = aws_secretsmanager_secret.contract["DATABASE_URL"].id
  secret_string = "postgresql://${var.db_username}:${urlencode(random_password.database.result)}@${aws_db_instance.this.address}:5432/${var.db_name}?sslmode=no-verify"
}

resource "aws_lb" "this" {
  name               = local.alb_name
  load_balancer_type = "application"
  subnets            = local.subnet_ids
  security_groups    = [aws_security_group.alb.id]
  tags               = local.tags
}

resource "aws_lb_target_group" "service" {
  for_each    = local.ingress_services
  name        = "${substr(var.cluster_name, 0, 20)}-${substr(replace(each.key, "-", ""), 0, 4)}-${substr(sha1("${var.cluster_name}:${each.key}"), 0, 6)}"
  port        = each.value.internal_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.vpc_id
  health_check {
    path    = "/healthz"
    matcher = "200-399"
  }
  tags = local.tags
}

resource "aws_lb_listener" "public" {
  load_balancer_arn = aws_lb.this.arn
  port              = var.certificate_arn == "" ? 80 : 443
  protocol          = var.certificate_arn == "" ? "HTTP" : "HTTPS"
  certificate_arn   = var.certificate_arn == "" ? null : var.certificate_arn
  ssl_policy        = var.certificate_arn == "" ? null : "ELBSecurityPolicy-TLS13-1-2-2021-06"
  dynamic "default_action" {
    for_each = local.has_portal ? ["portal"] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.service[default_action.value].arn
    }
  }
  dynamic "default_action" {
    for_each = local.has_portal ? [] : ["not-found"]
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "text/plain"
        message_body = "not found"
        status_code  = "404"
      }
    }
  }
}

resource "aws_cloudfront_distribution" "portal" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = var.cluster_name

  origin {
    domain_name = aws_lb.this.dns_name
    origin_id   = "portal-alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "portal-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Accept", "Authorization", "CloudFront-Forwarded-Proto", "Content-Type", "Origin", "Referer", "Sec-Fetch-Site"]
      cookies { forward = "all" }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.tags
}

resource "aws_lb_listener_rule" "paths" {
  for_each     = local.direct_path_services
  listener_arn = aws_lb_listener.public.arn
  priority     = 10 + index(sort(keys(var.services)), each.key)
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.key].arn
  }
  condition {
    path_pattern { values = each.value }
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = var.services
  name              = "/ecs/${each.value.ecs_service}"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_ecs_task_definition" "bootstrap" {
  for_each                 = var.services
  family                   = each.value.ecs_service
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = coalesce(each.value.execution_role_arn, local.default_execution_role_arn)
  task_role_arn            = coalesce(each.value.task_role_arn, each.key == "core" ? local.core_task_role_arn : local.default_task_role_arn)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = each.value.architecture == "amd64" ? "X86_64" : "ARM64"
  }
  container_definitions = jsonencode([{ name = each.key, image = "public.ecr.aws/docker/library/alpine:3.20", essential = true, command = ["sh", "-c", "while true; do nc -l -p ${each.value.internal_port} -e echo ok; done"], portMappings = [{ containerPort = each.value.internal_port }], logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.service[each.key].name, awslogs-region = var.region, awslogs-stream-prefix = each.key } } }])
  tags                  = local.tags
}

resource "aws_ecs_service" "service" {
  for_each        = var.services
  depends_on      = [aws_lb_listener.public, aws_lb_listener_rule.paths]
  name            = each.value.ecs_service
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.bootstrap[each.key].arn
  desired_count   = 0
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = local.service_security_groups
    assign_public_ip = true
  }
  service_registries { registry_arn = aws_service_discovery_service.service[each.key].arn }
  dynamic "load_balancer" {
    for_each = contains(keys(local.ingress_services), each.key) ? [each.key] : []
    content {
      target_group_arn = aws_lb_target_group.service[load_balancer.value].arn
      container_name   = each.key
      container_port   = each.value.internal_port
    }
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
  tags = local.tags
}
