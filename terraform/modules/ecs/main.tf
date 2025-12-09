# ECR Repository (optional - use if not using GitHub Container Registry)
resource "aws_ecr_repository" "vision" {
  name                 = "${var.environment}-forge-vision"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.environment}-forge-vision-ecr"
  }
}

# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = var.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${var.environment}-${var.cluster_name}"
  }
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.environment}/${var.service_name}"
  retention_in_days = 7

  tags = {
    Name = "${var.environment}-${var.service_name}-logs"
  }
}

# IAM Role for ECS Task Execution
resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.environment}-${var.service_name}-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.environment}-${var.service_name}-task-execution-role"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# IAM Role for ECS Task (application)
resource "aws_iam_role" "ecs_task" {
  name = "${var.environment}-${var.service_name}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.environment}-${var.service_name}-task-role"
  }
}

# ECS Task Definition
resource "aws_ecs_task_definition" "main" {
  family                   = "${var.environment}-${var.service_name}"
  network_mode             = "bridge"
  requires_compatibilities = ["EC2"]
  cpu                      = var.container_cpu
  memory                   = var.container_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = var.service_name
      image     = var.container_image
      cpu       = var.container_cpu
      memory    = var.container_memory
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = 0  # Dynamic port mapping
          protocol      = "tcp"
        }
      ]

      environment = concat(
        [
          {
            name  = "PORT"
            value = tostring(var.container_port)
          },
          {
            name  = "BACKEND_URL"
            value = var.backend_url
          }
        ],
        var.openai_api_key != "" ? [
          {
            name  = "OPENAI_API_KEY"
            value = var.openai_api_key
          }
        ] : [],
        var.gemini_api_key != "" ? [
          {
            name  = "GEMINI_API_KEY"
            value = var.gemini_api_key
          }
        ] : []
      )

      # GPU resource requirements
      resourceRequirements = var.gpu_enabled ? [
        {
          type  = "GPU"
          value = "1"
        }
      ] : []

      # Enable Docker GPU runtime
      linuxParameters = var.gpu_enabled ? {
        devices = [
          {
            hostPath      = "/dev/nvidia0"
            containerPath = "/dev/nvidia0"
            permissions   = ["read", "write", "mknod"]
          },
          {
            hostPath      = "/dev/nvidiactl"
            containerPath = "/dev/nvidiactl"
            permissions   = ["read", "write", "mknod"]
          },
          {
            hostPath      = "/dev/nvidia-uvm"
            containerPath = "/dev/nvidia-uvm"
            permissions   = ["read", "write", "mknod"]
          }
        ]
        capabilities = {
          add = ["SYS_ADMIN"]
        }
      } : null

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:${var.container_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = {
    Name = "${var.environment}-${var.service_name}-task"
  }
}

# Application Load Balancer
resource "aws_lb" "main" {
  name               = "${var.environment}-forge-vision-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnets

  enable_deletion_protection = false

  tags = {
    Name = "${var.environment}-forge-vision-alb"
  }
}

# ALB Target Group
resource "aws_lb_target_group" "main" {
  name     = "${var.environment}-forge-vision-tg"
  port     = var.container_port
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  target_type = "instance"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = var.health_check_interval
    path                = var.health_check_path
    matcher             = "200"
  }

  deregistration_delay = 30

  tags = {
    Name = "${var.environment}-forge-vision-tg"
  }
}

# ALB Listener
resource "aws_lb_listener" "main" {
  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.main.arn
  }
}

# Data source for current region
data "aws_region" "current" {}

# Data source for ECS-optimized AMI with GPU support
data "aws_ssm_parameter" "ecs_gpu_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id"
}

# Launch Template for EC2 instances
resource "aws_launch_template" "ecs" {
  name_prefix   = "${var.environment}-forge-vision-"
  image_id      = data.aws_ssm_parameter.ecs_gpu_ami.value
  instance_type = var.instance_type

  vpc_security_group_ids = [var.ecs_security_group_id]

  iam_instance_profile {
    name = aws_iam_instance_profile.ecs.name
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = 50
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    echo ECS_CLUSTER=${aws_ecs_cluster.main.name} >> /etc/ecs/ecs.config
    echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config
    echo ECS_ENABLE_TASK_IAM_ROLE=true >> /etc/ecs/ecs.config
    echo ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true >> /etc/ecs/ecs.config
  EOF
  )

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "${var.environment}-forge-vision-ecs-instance"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# IAM Role for EC2 instances
resource "aws_iam_role" "ecs_instance" {
  name = "${var.environment}-${var.service_name}-ecs-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.environment}-${var.service_name}-ecs-instance-role"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_instance" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "ecs" {
  name = "${var.environment}-${var.service_name}-ecs-instance-profile"
  role = aws_iam_role.ecs_instance.name
}

# Auto Scaling Group
resource "aws_autoscaling_group" "ecs" {
  name                = "${var.environment}-forge-vision-asg"
  vpc_zone_identifier = var.private_subnets
  desired_capacity    = var.desired_capacity
  min_size            = var.min_size
  max_size            = var.max_size
  health_check_type   = "EC2"
  health_check_grace_period = 300

  launch_template {
    id      = aws_launch_template.ecs.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "${var.environment}-forge-vision-ecs-instance"
    propagate_at_launch = true
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [desired_capacity]
  }
}

# ECS Capacity Provider
resource "aws_ecs_capacity_provider" "main" {
  name = "${var.environment}-forge-vision-capacity-provider"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs.arn
    managed_termination_protection = "DISABLED"

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 100
    }
  }

  tags = {
    Name = "${var.environment}-forge-vision-capacity-provider"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = [aws_ecs_capacity_provider.main.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 1
    base              = 0
  }
}

# ECS Service
resource "aws_ecs_service" "main" {
  name            = var.service_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.main.arn
  desired_count   = var.desired_capacity

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 1
    base              = 0
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.main.arn
    container_name   = var.service_name
    container_port   = var.container_port
  }

  deployment_configuration {
    maximum_percent         = 200
    minimum_healthy_percent = 100
  }

  depends_on = [
    aws_lb_listener.main,
    aws_iam_role_policy_attachment.ecs_task_execution
  ]

  tags = {
    Name = "${var.environment}-${var.service_name}"
  }
}

# Auto Scaling Target for ECS Service
resource "aws_appautoscaling_target" "ecs" {
  count = var.enable_autoscaling ? 1 : 0

  max_capacity       = var.max_size * 2  # Tasks per instance
  min_capacity       = var.min_size
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.main.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Auto Scaling Policy - CPU
resource "aws_appautoscaling_policy" "ecs_cpu" {
  count = var.enable_autoscaling ? 1 : 0

  name               = "${var.environment}-${var.service_name}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = var.cpu_threshold

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# Auto Scaling Policy - Memory
resource "aws_appautoscaling_policy" "ecs_memory" {
  count = var.enable_autoscaling ? 1 : 0

  name               = "${var.environment}-${var.service_name}-memory-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = var.memory_threshold

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }

    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
