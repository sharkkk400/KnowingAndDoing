# 沙克知行录 iOS

完整 GP 工作台的 iOS 客户端，使用 SwiftUI + WKWebView。包括原有行情、ETF/指数、消息依据、份额、候选跟踪、策略建议及推演复盘；JSON 导出通过 iOS 分享面板保存。外部资讯在系统浏览器打开。

项目：`GP.xcodeproj`，Scheme：`GP`，最低 iOS 18。App 显示名为「沙克知行录」，Bundle ID 为 `com.shark.guanpan`。签名团队可在 Xcode 的 Signing & Capabilities 修改。

## 连接 GP

1. 在原目录 `/Users/shark/work/GP` 运行 `npm start`，GP 保持只监听本机 5178。
2. 在本项目运行 `bridge/server.mjs`，明确提供 `GP_MOBILE_HOST`（电脑可供手机访问的地址）、`GP_ACCESS_TOKEN`（至少32字符随机令牌），可选 `GP_MOBILE_PORT`（默认5179）。令牌不要提交到仓库。
3. 手机与电脑需网络互通。在 App 设置里填写 `http://电脑地址:5179` 和对应令牌，允许本地网络访问。令牌保存在 iOS 钥匙串。

网关只代理到本机 GP，校验 Host、令牌、Origin 与跨站请求；不更改 GP 访问控制。局域网调试使用 HTTP；跨不可信网络应部署 HTTPS 或使用受控网络，不直接公开该调试入口。App 未处理或绕过证书错误。

开发启动时可通过进程环境 `GP_SERVER_URL`、`GP_ACCESS_TOKEN` 预置连接，不将令牌编入安装包。正式使用通过设置界面配置。

## 真机

连接、解锁并信任 iPhone，启用开发者模式。在 Xcode 选择手机运行，或使用：

```sh
xcodebuild -project GP.xcodeproj -scheme GP -configuration Debug -destination 'id=设备UDID' -derivedDataPath /tmp/shark-market-ios-build -allowProvisioningUpdates build
xcrun devicectl device install app --device 设备UDID /tmp/shark-market-ios-build/Build/Products/Debug-iphoneos/GP.app
xcrun devicectl device process launch --device 设备UDID com.shark.guanpan
```

网关校验：`node --test bridge/server.test.mjs`。原 GP 的业务测试仍在原项目运行。

## 范围

这是保留完整网页业务能力的原生客户端外壳，不是逐屏 SwiftUI 重写。后台仍运行在电脑或服务器；离线不能获得新行情。每早8点计划、消息综合、推送和自动交易未在本版新增。iOS 后台不能代替常驻服务器定时任务。
