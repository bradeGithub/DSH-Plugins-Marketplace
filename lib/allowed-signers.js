// 自更新 release 签名信任根（编译期常量）。
// 安全约束：只允许读「当前已安装」bundle 里的这份文件——staged/远端仓库里的同名文件
// 概不采信，否则攻击者在恶意 release 中替换本文件即可完成自传播接管。
// 新增/轮换 key 只能随「已信任 key 签名的 release」进入本常量（forward-only）；
// 失窃 key 加入 REVOKED_KEYS，由另一把仍可信的 key 签名的 release 下发。

export const ALLOWED_SIGNERS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKGkB2MWkMxJ4zHvlK6D6Of1dW8epdl1ehVAXyoLNmM dsh-marketplace-release-1",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPuxRqsGQiJxPQf/xHM5BFrTxGUaKMYG+HrFzpj+da7Q dsh-marketplace-release-2"
];

// 吊销集合：存放被吊销公钥的完整 base64 key blob（与 allowed_signers 行第二列一致）。
export const REVOKED_KEYS = [];
