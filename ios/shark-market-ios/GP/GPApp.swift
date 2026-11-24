import SwiftUI
import WebKit
import UniformTypeIdentifiers
import Security

enum AccessToken {
    private static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.shark.guanpan", kSecAttrAccount as String: "server-token"] }
    static func read() -> String {
        var lookup = query
        lookup[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    @discardableResult static func save(_ value: String) -> Bool {
        let data = [kSecValueData as String: Data(value.utf8)]
        let status = SecItemUpdate(query as CFDictionary, data as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var item = query.merging(data) { _, new in new }
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }
}

@main
struct GPApp: App {
    var body: some Scene { WindowGroup { WorkspaceView() } }
}

@MainActor
final class WorkspaceModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    @Published var loading = false
    @Published var error: String?
    @Published var exportURL: URL?
    let webView: WKWebView
    private var origin: URL?
    private var downloads: [ObjectIdentifier: URL] = [:]

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.043, green: 0.067, blue: 0.11, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.allowsBackForwardNavigationGestures = true
        webView.accessibilityLabel = "GP 完整工作台"
    }

    static func validatedURL(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { return nil }
        return url
    }

    func load(_ text: String) {
        guard let url = Self.validatedURL(text) else { error = "请输入完整服务器地址，例如 http://192.168.1.10:5178"; return }
        origin = url
        error = nil
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        let token = AccessToken.read()
        if !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        webView.load(request)
    }

    func reload() { if let origin { load(origin.absoluteString) } }

    private func isWorkspace(_ url: URL) -> Bool {
        guard let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true; error = nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError failure: Error) { failed(failure) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError failure: Error) { failed(failure) }
    private func failed(_ failure: Error) {
        if (failure as NSError).code == NSURLErrorCancelled { return }
        loading = false
        error = "未能连接 GP：\(failure.localizedDescription)\n请确认后台正在运行，手机能够访问该服务器，并已允许本地网络访问。"
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loading = false
        error = "工作台页面已停止，点击重新加载恢复。"
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload && isWorkspace(url) { decisionHandler(.download); return }
        if isWorkspace(url) { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            error = "服务器返回 HTTP \(http.statusCode)，请检查服务器地址和访问配置。"
            loading = false
            decisionHandler(.cancel)
            return
        }
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent((suggestedFilename as NSString).lastPathComponent)
            downloads[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch { self.error = "无法创建导出文件：\(error.localizedDescription)"; completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        loading = false
        exportURL = downloads.removeValue(forKey: ObjectIdentifier(download))
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        loading = false
        self.error = "导出失败：\(error.localizedDescription)"
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") {
            if isWorkspace(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }
}

struct WorkspaceWebView: UIViewRepresentable {
    let model: WorkspaceModel
    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct WorkspaceView: View {
    @AppStorage("gp.serverAddress") private var address = ""
    @StateObject private var model = WorkspaceModel()
    @State private var settings = false
    @Environment(\.scenePhase) private var phase
    var body: some View {
        NavigationStack {
            ZStack {
                Color(red: 0.043, green: 0.067, blue: 0.11).ignoresSafeArea()
                if address.isEmpty {
                    ContentUnavailableView {
                        Label("沙克知行录", systemImage: "chart.xyaxis.line")
                    } description: {
                        Text("连接你的 GP 服务器，查看完整行情工作台、ETF 份额、候选计划与推演复盘。")
                    } actions: {
                        Button("连接服务器") { settings = true }.buttonStyle(.borderedProminent)
                    }
                } else { WorkspaceWebView(model: model) }
                if let error = model.error {
                    VStack(spacing: 18) {
                        Image(systemName: "wifi.exclamationmark").font(.largeTitle)
                        Text(error).multilineTextAlignment(.center)
                        HStack {
                            Button("服务器设置") { settings = true }
                            Button("重新加载") { model.reload() }.buttonStyle(.borderedProminent)
                        }
                    }.padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20)).padding()
                }
            }
            .navigationTitle("沙克知行录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { settings = true } label: { Image(systemName: "server.rack") }.accessibilityLabel("服务器设置")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.loading { ProgressView() }
                    else { Button { model.reload() } label: { Image(systemName: "arrow.clockwise") }.disabled(address.isEmpty).accessibilityLabel("重新加载工作台") }
                }
            }
            .sheet(isPresented: $settings, onDismiss: { if !address.isEmpty { model.load(address) } }) { ServerSettings(address: $address) }
            .sheet(isPresented: Binding(get: { model.exportURL != nil }, set: { if !$0 { model.exportURL = nil } })) {
                if let url = model.exportURL { ExportSheet(url: url) }
            }
            .onAppear {
                // Development launch can provision the connection without embedding credentials in the app.
                let environment = ProcessInfo.processInfo.environment
                if let token = environment["GP_ACCESS_TOKEN"] { AccessToken.save(token) }
                if let server = environment["GP_SERVER_URL"], WorkspaceModel.validatedURL(server) != nil { address = server }
                if !address.isEmpty && model.webView.url == nil { model.load(address) }
            }
            .onChange(of: address) { _, value in if !value.isEmpty { model.load(value) } }
            .onChange(of: phase) { _, value in
                if value == .active && !address.isEmpty && model.error == nil {
                    // Reload on return so a backgrounded screen cannot appear live with old data.
                    model.load(address)
                }
            }
        }.preferredColorScheme(.dark).tint(Color(red: 0.28, green: 0.83, blue: 0.8))
    }
}

struct ServerSettings: View {
    @Binding var address: String
    @State private var draft = ""
    @State private var invalid = false
    @State private var token = ""
    @State private var tokenError = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("GP 服务器地址") {
                    TextField("http://192.168.1.10:5178", text: $draft)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if invalid { Text("请输入 http 或 https 地址，不含账号、查询参数或子路径。地址需指向 GP 后台。 ").foregroundStyle(.red) }
                }
                Section {
                    SecureField("访问令牌", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("连接手机访问服务时填写对应令牌，令牌保存在本机钥匙串。")
                    if tokenError { Text("无法保存访问令牌，请重试。").foregroundStyle(.red) }
                }
                Section {
                    Text("真机上的 localhost 指手机自身。请填写运行 GP 的电脑在同一网络中的地址，或你部署的 HTTPS 地址。")
                    Text("行情与策略由服务器计算；手机退出后，后台是否持续采集取决于服务器是否运行。")
                }
                Section("连接方式") {
                    Text("首次连接本地服务器时，请允许本地网络访问。当前版本保留 GP 原有功能；早上 8 点计划与推送尚未接入。")
                }
            }
            .navigationTitle("服务器设置").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("连接") {
                        guard let url = WorkspaceModel.validatedURL(draft) else { invalid = true; return }
                        guard AccessToken.save(token.trimmingCharacters(in: .whitespacesAndNewlines)) else { tokenError = true; return }
                        address = url.absoluteString
                        dismiss()
                    }
                }
            }
            .onAppear { draft = address; token = AccessToken.read() }
        }
    }
}

struct ExportSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
