// 自更新 release 签名信任根（编译期常量）。
// 安全约束：只允许读「当前已安装」bundle 里的这份文件——staged/远端仓库里的同名文件
// 概不采信，否则攻击者在恶意 release 中替换本文件即可完成自传播接管。
//
// 建模语义：每行 key 对应一位「可独立发版的维护者」（按人归因，signedBy 记录署名），
// 不是按机器——同人多机可各持一把，或一人主备两把。
//   入职（新维护者获得发版权）：对方本机 ssh-keygen -t ed25519 → .pub 经普通 PR
//     加入本常量 → 下一个由任一已信 key 签名的 release 起生效。此后独立发版，
//     无需再经他人签名（一次性信任委托，非每次依赖）。
//   吊销（key 失窃/维护者退出）：把完整 base64 key blob 移入 REVOKED_KEYS，
//     由另一把仍可信的 key 签名的 release 下发——跨人冗余优于同机双 key。
export const ALLOWED_SIGNERS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKGkB2MWkMxJ4zHvlK6D6Of1dW8epdl1ehVAXyoLNmM release-lu",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPuxRqsGQiJxPQf/xHM5BFrTxGUaKMYG+HrFzpj+da7Q release-lu-backup"
];

// 吊销集合：存放被吊销公钥的完整 base64 key blob（与 allowed_signers 行第二列一致）。
export const REVOKED_KEYS = [];
