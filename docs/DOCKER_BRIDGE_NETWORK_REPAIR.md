# Docker bridge 网络故障排查与修复

本文档用于排查 Linux 宿主机上 Docker bridge 网络异常，尤其适用于以下现象：

- 容器已经获得 IP 地址和默认路由，但无法访问 bridge 网关。
- 容器访问公网时返回 `Host is unreachable`。
- `docker0` 和 veth 均已创建，看起来却无法通信。
- Docker 网络已删除，但宿主机仍残留同名或同网段的 bridge 接口。

本文记录的实际案例最终定位为：一个不再受 Docker 管理的残留 bridge 与
`docker0` 同时持有 `172.17.0.1/16`，造成地址和路由冲突，宿主机因而不响应
容器发出的网关 ARP 请求。

## 安全提示

- 需要查看或修改宿主机网络规则的命令应使用 `sudo`。
- 不要直接执行 `iptables -F`、`iptables -t nat -F` 或清空整套 nftables
  规则。这可能中断 SSH、宿主机防火墙和所有容器网络。
- 删除 bridge 或 Docker 网络前，必须确认它没有承载业务容器。
- 重启 Docker 可能影响容器网络。即使启用了 `live-restore`，也不能假定网络
  连接不会中断。

## 一、确认默认 bridge 配置

先记录 Docker 版本和 daemon 配置，便于判断宿主机使用的是旧版 iptables 还是较新的
防火墙后端：

```bash
docker version
docker info
sudo cat /etc/docker/daemon.json 2>/dev/null
```

不要依赖下面的模板探测防火墙后端：

```text
docker info --format 'FirewallBackend={{.FirewallBackend}}'
```

一些旧版 Docker 的 `dockerInfo` 没有 `.FirewallBackend` 字段，会返回 template
解析错误；这不代表防火墙后端本身发生故障。

查看 Docker 默认 bridge 的网段、网关和 Linux 接口名：

```bash
docker network inspect bridge \
  --format 'Subnet={{range .IPAM.Config}}{{.Subnet}}{{end}} Gateway={{range .IPAM.Config}}{{.Gateway}}{{end}} Bridge={{index .Options "com.docker.network.bridge.name"}}'

ip -4 addr show docker0
```

后续命令以常见的 `172.17.0.0/16` 和 `172.17.0.1` 为示例。如果 inspect 返回不同
网段或网关，应替换成实际值。

注意，读取 `.Options` 中的 bridge 名称必须使用 Go template 的 `index`。下面的
写法是错误的：

```text
{{.Options "com.docker.network.bridge.name"}}
```

检查容器实际获得的地址和路由：

```bash
docker run --rm node:22-alpine sh -c 'ip addr; ip route'
```

正常情况下，默认配置类似：

```text
docker0: 172.17.0.1/16
container eth0: 172.17.0.2/16
default via 172.17.0.1 dev eth0
```

没有容器连接时，`docker0` 显示 `NO-CARRIER` 或 `state DOWN` 通常是正常现象。
应在常驻测试容器运行期间判断接口状态：

```bash
docker run -d --rm --name bridge-test node:22-alpine sleep 600
ip -br link show docker0
```

## 二、先区分二层故障和三层转发故障

从容器内 ping 网关，并查看 ARP 邻居项：

```bash
docker exec bridge-test sh -c '
  ping -c2 -W2 172.17.0.1 || true
  echo "--- ARP neighbor ---"
  ip neigh show
'
```

根据邻居项判断故障层级：

| 邻居状态 | 含义 | 后续方向 |
| --- | --- | --- |
| `REACHABLE`、`STALE` 或存在 `lladdr` | ARP 正常，二层通信已建立 | 检查 FORWARD、NAT 和上游网络 |
| `INCOMPLETE` 或 `FAILED` | 网关没有回应 ARP | 检查 bridge、重复地址、VLAN、ARP sysctl 和 ebtables |

如果邻居项为 `INCOMPLETE`，普通 iptables 的 filter/NAT 规则还不是当前重点，因为
数据包尚未进入 IP 转发阶段。

必要时抓取 ARP 包：

```bash
sudo timeout 8 tcpdump -eni any arp &
TCPDUMP_PID=$!
sleep 1
docker exec bridge-test ping -c2 -W2 172.17.0.1 || true
wait "$TCPDUMP_PID"
```

正常抓包应同时看到 Request 和 Reply：

```text
ARP, Request who-has 172.17.0.1 tell 172.17.0.2
ARP, Reply 172.17.0.1 is-at 02:42:...
```

如果只能看到 Request，说明请求已经离开容器，但宿主机没有对网关地址作出回应。

## 三、检查 bridge 数据路径

获取容器 eth0 对应的宿主机 veth ifindex：

```bash
IFINDEX=$(docker exec bridge-test cat /sys/class/net/eth0/iflink)
echo "host veth ifindex=$IFINDEX"
```

部分旧版本 `iproute2` 不支持直接通过 ifindex 执行 `ip link show "$IFINDEX"`。
可以从完整输出中查找该编号：

```bash
ip -d link show | grep -A1 "^${IFINDEX}:"
bridge -d link show | grep -A1 "^${IFINDEX}:"
```

检查 bridge 和 VLAN 状态：

```bash
ip -d link show docker0
bridge -d link show
bridge vlan show
```

默认 bridge 通常应满足：

- 测试容器的宿主机 veth 以 `master docker0` 挂载。
- veth 端口为 `state forwarding`。
- `docker0` 的 `vlan_filtering` 为 `0`。
- veth 的 `learning` 和 `flood` 为 `on`。

检查 ARP 相关 sysctl：

```bash
sysctl \
  net.ipv4.conf.all.arp_ignore \
  net.ipv4.conf.default.arp_ignore \
  net.ipv4.conf.docker0.arp_ignore \
  net.ipv4.conf.all.arp_filter \
  net.ipv4.conf.docker0.arp_filter
```

一般应为 `0`。如果环境没有刻意配置 ARP 强化策略，可以临时恢复后复测：

```bash
sudo sysctl -w net.ipv4.conf.all.arp_ignore=0
sudo sysctl -w net.ipv4.conf.default.arp_ignore=0
sudo sysctl -w net.ipv4.conf.docker0.arp_ignore=0
sudo sysctl -w net.ipv4.conf.all.arp_filter=0
sudo sysctl -w net.ipv4.conf.docker0.arp_filter=0
```

检查二层过滤规则：

```bash
sudo arptables -L -n 2>/dev/null
sudo ebtables -t filter -L --Lc 2>/dev/null
sudo ebtables -t nat -L --Lc 2>/dev/null
sudo ebtables -t broute -L --Lc 2>/dev/null
```

不要在没有确认规则归属和影响范围前清空这些规则。

## 四、检查重复 bridge 地址和路由

这是本案例的关键步骤。列出所有 bridge 地址，以及默认网段对应的路由：

```bash
ip -4 addr show type bridge
ip rule show
ip route show table local | grep 172.17
ip route show table main | grep 172.17
```

正常情况下，`172.17.0.1` 和 `172.17.0.0/16` 只应属于 `docker0`：

```text
local 172.17.0.1 dev docker0 proto kernel scope host src 172.17.0.1
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
```

本案例的异常输出同时包含：

```text
local 172.17.0.1 dev br-83e699c90a9b ...
local 172.17.0.1 dev docker0 ...
172.17.0.0/16 dev br-83e699c90a9b ...
172.17.0.0/16 dev docker0 ...
```

即使冲突接口处于 `linkdown`，它的地址和本地路由仍可能影响 ARP 和路由选择。

## 五、安全删除冲突网络

假设冲突接口为 `br-83e699c90a9b`，先判断它是否仍受 Docker 管理：

```bash
docker network ls --no-trunc | grep -E '83e699c90a9b|NETWORK'

docker network inspect 83e699c90a9b \
  --format 'Name={{.Name}} ID={{.Id}} Containers={{len .Containers}} Subnet={{range .IPAM.Config}}{{.Subnet}} Gateway={{.Gateway}}{{end}}'
```

根据结果选择一种处理方式。

### 情况 A：Docker 网络存在且没有容器

当 `docker network inspect` 成功且 `Containers=0` 时，通过 Docker 删除：

```bash
docker network rm 83e699c90a9b
```

### 情况 B：Docker 网络存在且仍有关联容器

先列出容器，不要直接删除网络：

```bash
docker network inspect 83e699c90a9b \
  --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{println}}{{end}}'
```

应先安排业务容器停机或迁移，并使用不与 `docker0`、宿主机 LAN/VPN、其他 Docker
网络重叠的新网段重建该网络。

### 情况 C：Docker 网络不存在，但 Linux bridge 仍存在

如果 Docker 返回 `network ... not found`，说明这是脱离 Docker 网络数据库的内核
残留接口。确认它不承载业务接口后删除：

```bash
sudo ip link delete br-83e699c90a9b type bridge
```

删除接口时，内核会同步移除它对应的地址和路由。

## 六、验证修复

确认冲突接口和重复路由已经消失：

```bash
ip link show br-83e699c90a9b 2>&1
ip route show table local | grep 172.17
ip route show table main | grep 172.17
```

清理旧测试容器后重新验证：

```bash
docker rm -f bridge-test 2>/dev/null || true

docker run --rm node:22-alpine sh -c '
  ip route
  ping -c2 -W2 172.17.0.1
  wget -q -T5 -t1 -O /dev/null http://1.1.1.1
  echo "egress=$?"
'
```

成功标准：

- 网关 ping 收到响应。
- ARP 邻居项包含网关 MAC 地址，不再是 `INCOMPLETE`。
- 公网测试返回 `egress=0`。

本案例删除残留 bridge 后，容器立即恢复对 `172.17.0.1` 的访问，无需清空
iptables，也无需再次重建 `docker0`。

## 七、网关恢复但公网仍不通

如果容器可以访问 `172.17.0.1`，但不能访问公网，故障已经从二层转移到 IP 转发、
NAT 或上游网络。继续检查：

```bash
sysctl net.ipv4.ip_forward
sudo iptables -nvL FORWARD --line-numbers
sudo iptables -t nat -nvL POSTROUTING --line-numbers
sudo iptables -nvL DOCKER-USER --line-numbers
sudo iptables -t nat -nvL DOCKER --line-numbers
systemctl is-active firewalld
```

应确认：

- `net.ipv4.ip_forward = 1`。
- FORWARD 链存在 Docker 生成的跳转和放行规则。
- POSTROUTING 链存在容器网段的 `MASQUERADE`。
- firewalld 或自定义规则没有在 Docker 规则之前直接拒绝转发。

如果 Docker 规则缺失，可以在评估业务影响后重启 Docker，让其重建规则：

```bash
sudo systemctl restart docker
```

## 八、防止问题复发

1. 定期对比 Docker 网络数据库和宿主机 bridge：

   ```bash
   docker network ls --no-trunc
   ip -4 addr show type bridge
   ```

2. 创建 Compose 或手工 bridge 网络时，避免与以下地址重叠：

   - Docker 默认 bridge 网段。
   - 宿主机 LAN 网段。
   - VPN、Kubernetes Pod/Service 网段。
   - 已存在的 Docker 自定义网络。

3. 如果必须显式指定网段，在部署前检查：

   ```bash
   docker network inspect bridge
   docker network inspect $(docker network ls -q)
   ip route show
   ```

4. 如果删除 Docker 网络后仍看到对应的 `br-<network-id>`，确认没有业务端口后及时
   清理残留接口。

5. 如果残留 bridge 在重启后自动出现，检查宿主机网络管理配置：

   ```bash
   nmcli connection show 2>/dev/null | grep '<bridge-name>'
   grep -R '<bridge-name>\|<gateway-address>' \
     /etc/sysconfig/network-scripts \
     /etc/systemd/network \
     /etc/NetworkManager 2>/dev/null
   ```

## 快速决策表

| 现象 | 优先检查 | 常见原因 |
| --- | --- | --- |
| 容器没有 IP 或默认路由 | `docker network inspect`、容器 `ip addr` | Docker IPAM 或 endpoint 创建失败 |
| 网关邻居为 `INCOMPLETE` | ARP 抓包、bridge 地址和 local 路由 | 重复 bridge 地址、残留接口、二层过滤 |
| 网关可 ping，公网不可达 | FORWARD、POSTROUTING、`ip_forward` | Docker 规则缺失、防火墙拒绝、上游路由异常 |
| 域名失败但数字 IP 可达 | 容器 `/etc/resolv.conf`、daemon DNS | DNS 配置或 DNS 服务不可达 |
| `docker0` 无容器时显示 DOWN | 是否存在已连接容器 | 通常为正常的无 carrier 状态 |
