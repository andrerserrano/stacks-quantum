import Foundation
import Security

// The secret arrives over stdin, never a command-line argument.
// `get` is consumed directly by the local Node process, never printed to chat.
let args = CommandLine.arguments
guard args.count == 4, ["put", "get"].contains(args[1]) else {
    fputs("usage: keychain-store put|get SERVICE ACCOUNT\n", stderr)
    exit(2)
}
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: args[2],
    kSecAttrAccount as String: args[3],
]
var status: OSStatus
if args[1] == "put" {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { exit(2) }
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    status = SecItemAdd(query as CFDictionary, nil)
} else {
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data {
        FileHandle.standardOutput.write(data)
    }
}
if status != errSecSuccess {
    fputs("Keychain operation failed (OSStatus \(status)).\n", stderr)
    exit(1)
}
