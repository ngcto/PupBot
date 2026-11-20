"use client";

import { Toaster as SonnerToaster, toast } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      duration={4000}
      toastOptions={{
        style: {
          background: "#1f1f1f",
          border: "1px solid #343434",
          color: "#f5f5f5",
          borderRadius: "12px",
          fontSize: "13px",
        },
      }}
    />
  );
}

export { toast };
