data "aws_ssm_parameter" "latest_amazon_linux" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_iam_role" "ssm" {
  name = "${var.name}-ssm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ssm" {
  name = "${var.name}-ssm-profile"
  role = aws_iam_role.ssm.name
}

resource "aws_security_group" "web" {
  name = var.name

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "apache" {
    ami                    = data.aws_ssm_parameter.latest_amazon_linux.value
    instance_type          = "t3.micro"
    vpc_security_group_ids = [aws_security_group.web.id]
    iam_instance_profile   = aws_iam_instance_profile.ssm.name

    user_data = file("user-data.sh")

    tags = {
        Name = var.name
    }
}

output "instance_id" {
  value = aws_instance.apache.id
}

output "ssm_connect_command" {
  value = "aws ssm start-session --target ${aws_instance.apache.id}"
}