import { createRoot } from "react-dom/client";
import { MotherDuckSDKProvider, useConnectionStatus } from "./md-sdk";
import { Loader2, AlertCircle } from "lucide-react";
import Dive from "./dive";

function ConnectionGate({ children }: { children: React.ReactNode }) {
  const { isConnected, isConnecting, error } = useConnectionStatus();
  if (isConnecting) return (
    <div className="flex items-center justify-center h-screen gap-2 text-[#6a6a6a]">
      <Loader2 className="animate-spin" size={20} />
      Connecting to MotherDuck…
    </div>
  );
  if (error) return (
    <div className="flex items-center justify-center h-screen gap-2 text-red-600">
      <AlertCircle size={20} />
      Connection failed: {error.message}
    </div>
  );
  if (!isConnected) return null;
  return <>{children}</>;
}

const token = import.meta.env.VITE_MOTHERDUCK_TOKEN;
if (!token) {
  document.getElementById("root")!.innerHTML =
    '<p style="padding:2rem;color:red">Missing VITE_MOTHERDUCK_TOKEN in .env</p>';
} else {
  createRoot(document.getElementById("root")!).render(
    <MotherDuckSDKProvider token={token}>
      <ConnectionGate>
        <Dive />
      </ConnectionGate>
    </MotherDuckSDKProvider>
  );
}
