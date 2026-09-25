import { api } from '../api';
import { Card, Empty, ErrorBanner, fmtTime, PageHeader, Spinner, useAsync } from '../components/ui';
import type { Policy } from '../types';

/**
 * Read-only policy list. Creating and editing policies is done through the
 * API (`POST/PUT /v1/policies`); the console builder is not implemented yet.
 */
export default function PoliciesPage() {
  const { data, error, loading } = useAsync(() => api.get<{ policies: Policy[] }>('/policies'), []);
  return (
    <>
      <PageHeader title="Policies" subtitle="Reusable rule sets assigned to devices." />
      <div className="banner banner-info">
        The policy builder is not available in the console yet. Create and edit policies with the API
        (<code>POST /v1/policies</code>, <code>PUT /v1/policies/:id</code>) and assign them from a device’s page.
      </div>
      <Card>
        <ErrorBanner error={error} />
        {loading ? <Spinner /> : !data?.policies.length ? <Empty>No policies yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Version</th><th>Devices</th><th>Updated</th></tr></thead>
            <tbody>
              {data.policies.map((p) => (
                <tr key={p.id}><td className="strong">{p.name}</td><td>v{p.version}</td><td>{p.deviceCount ?? 0}</td><td>{fmtTime(p.updatedAt)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
