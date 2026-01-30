#!/bin/bash
dnf update -y
dnf install -y httpd

cat <<EOF >/etc/httpd/conf.d/demo.conf
<Directory "/var/www/html">
    Options Indexes
    AllowOverride None
    Require all granted
    DirectoryIndex index.html
    DirectorySlash Off
</Directory>
EOF

mkdir -p /var/www/html/demo

echo "Hello from index.html" > /var/www/html/demo/index.html
echo "SECRET: directory contents leaked" > /var/www/html/demo/secret.txt

systemctl enable httpd
systemctl restart httpd