"use client";
import { useState } from "react";
import { createClient } from "../../lib/supabase/client";

export default function TestDB() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function testConnection() {
    const supabase = createClient();

    const { data: clusters, error: clusterError } = await supabase
      .from("clusters")
      .select("name, display_order")
      .order("display_order");

    if (clusterError) {
      setError(clusterError.message);
      return;
    }

    const { data: channels, error: channelError } = await supabase
      .from("channels")
      .select("name, clusters(name)")
      .order("display_order");

    if (channelError) {
      setError(channelError.message);
      return;
    }

    const { count } = await supabase
      .from("sku_master")
      .select("*", { count: "exact", head: true });

    setData({ clusters, channels, skuCount: count });
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white p-8">
      <h1 className="text-2xl font-bold mb-6">Database Connection Test</h1>

      <button
        onClick={testConnection}
        className="px-6 py-3 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition"
      >
        Test Connection
      </button>

      {error && (
        <div className="mt-6 p-4 bg-red-900/50 border border-red-500 rounded-lg">
          <p className="text-red-300">Error: {error}</p>
        </div>
      )}

      {data && (
        <div className="mt-6 space-y-6">
          <div className="p-4 bg-green-900/30 border border-green-500 rounded-lg">
            <p className="text-green-300 font-semibold">✅ Connected Successfully!</p>
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-2 text-amber-400">
              Clusters ({data.clusters.length})
            </h2>
            <div className="flex flex-wrap gap-2">
              {data.clusters.map((c: any) => (
                <span key={c.name} className="px-3 py-1 bg-gray-800 rounded text-sm">
                  {c.name}
                </span>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-2 text-amber-400">
              Channels ({data.channels.length})
            </h2>
            <div className="flex flex-wrap gap-2">
              {data.channels.map((ch: any) => (
                <span key={ch.name} className="px-3 py-1 bg-gray-800 rounded text-sm">
                  {ch.name}
                  <span className="text-gray-500 ml-1 text-xs">
                    ({ch.clusters?.name})
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-2 text-amber-400">
              SKUs in Master
            </h2>
            <p className="text-gray-300">{data.skuCount} SKU(s) loaded</p>
          </div>
        </div>
      )}
    </main>
  );
}