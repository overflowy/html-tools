// The Checker's Monaco LSP client. The client registers its Monaco providers
// in its constructor and keeps no handle on them, so a restart would register
// a second set; this subclass hands the disposable to the Checker on the way
// past. Monaco's client class is only there once the editor has loaded, so
// the subclass is made from it then.

import type * as Monaco from "monaco-editor";

type ClientClass = typeof Monaco.lsp.MonacoLspClient;

export const capturingClient = (
  Base: ClientClass,
  capture: (features: { dispose: () => void }) => void
) =>
  class Client extends Base {
    protected override createFeatures() {
      const features = super.createFeatures();
      capture(features);
      return features;
    }
  };
