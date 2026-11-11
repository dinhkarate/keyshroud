// The local vault's Touch ID helper. It is built from this file on first use (xcrun swiftc) and
// cached in the config directory. It holds no vault key: Node wraps that key to the public half of
// a P-256 key kept in this Mac's Secure Enclave, and this helper answers the key agreement only after
// the person at the Mac approves (Touch ID, or the Mac's password).
//
// argv[1] is the operation and nothing else is ever in argv. The request is one JSON object on
// stdin, the answer one JSON object on stdout:
//   create {}                                         -> {"handle", "pub"}  never asks
//   agree  {"handle", "epk", "reason", "timeoutMs"}   -> {"z"}              asks once
// Exit codes: 0 ok; 1 failed (one "domain code" line on stderr, never key material); 2 no Secure
// Enclave; 3 not approved (cancelled, failed or timed out); 4 the key does not work on this Mac;
// 5 nobody can be asked here (SSH, a sandbox, a locked screen).
import CryptoKit
import CryptoTokenKit
import Foundation
import LocalAuthentication

func answer(_ object: [String: String]) -> Never {
  FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: object))
  exit(0)
}

func fail(_ code: Int32, _ error: Error? = nil) -> Never {
  if let error = error as NSError? { FileHandle.standardError.write(Data("\(error.domain) \(error.code)\n".utf8)) }
  exit(code)
}

// 3 for "not approved", 5 for "nobody can be asked", else nil. The reason may be nested.
func outcome(_ error: Error) -> Int32? {
  var next: NSError? = error as NSError
  while let e = next {
    switch (e.domain, e.code) {
    case (LAErrorDomain, LAError.Code.userCancel.rawValue), (LAErrorDomain, LAError.Code.appCancel.rawValue),
         (LAErrorDomain, LAError.Code.systemCancel.rawValue), (LAErrorDomain, LAError.Code.userFallback.rawValue),
         (LAErrorDomain, LAError.Code.authenticationFailed.rawValue), (LAErrorDomain, LAError.Code.invalidContext.rawValue),
         (TKErrorDomain, TKError.Code.canceledByUser.rawValue), (TKErrorDomain, TKError.Code.authenticationFailed.rawValue),
         (NSOSStatusErrorDomain, Int(errSecUserCanceled)), (NSOSStatusErrorDomain, Int(errSecAuthFailed)):
      return 3
    case (LAErrorDomain, LAError.Code.notInteractive.rawValue), (TKErrorDomain, TKError.Code.authenticationNeeded.rawValue),
         (NSOSStatusErrorDomain, Int(errSecInteractionNotAllowed)):
      return 5
    default:
      next = e.userInfo[NSUnderlyingErrorKey] as? NSError
    }
  }
  return nil
}

guard CommandLine.arguments.count == 2 else { fail(1) }
guard SecureEnclave.isAvailable else { fail(2) }
let request = (try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile())) as? [String: Any] ?? [:]

switch CommandLine.arguments[1] {
case "create":
  guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], nil) else { fail(1) }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    answer(["handle": key.dataRepresentation.base64EncodedString(), "pub": key.publicKey.x963Representation.base64EncodedString()])
  } catch { fail(outcome(error) == 5 ? 5 : 1, error) }
case "agree":
  guard let handle = (request["handle"] as? String).flatMap({ Data(base64Encoded: $0) }),
        let epk = (request["epk"] as? String).flatMap({ Data(base64Encoded: $0) }),
        let peer = try? P256.KeyAgreement.PublicKey(x963Representation: epk),
        let reason = request["reason"] as? String, !reason.isEmpty else { fail(1) }
  let timeoutMs = (request["timeoutMs"] as? Int) ?? 60_000
  let context = LAContext()
  context.localizedReason = reason
  let key: SecureEnclave.P256.KeyAgreement.PrivateKey
  // A blob from another Mac's Secure Enclave (or from before this one was erased) is refused here.
  do { key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: handle, authenticationContext: context) }
  catch { fail(outcome(error) == 5 ? 5 : 4, error) }
  let started = Date()
  // An unanswered sheet goes away after timeoutMs; the agreement then fails.
  DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { context.invalidate() }
  do {
    let z = try key.sharedSecretFromKeyAgreement(with: peer)  // the sheet shows here
    answer(["z": z.withUnsafeBytes { Data($0) }.base64EncodedString()])
  } catch {
    fail(Date().timeIntervalSince(started) * 1000 >= Double(timeoutMs) ? 3 : outcome(error) ?? 1, error)
  }
default:
  fail(1)
}
