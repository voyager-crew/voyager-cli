/**
 * `GET /v1/status` as this serve answers it: the protocol's `StatusResponse` plus a few
 * fields only `voyager status` reads, so they stay out of the wire package.
 */
import type { StatusResponse } from '@voyager-crew/bridge-protocol';

import type { ActiveJobView } from '../jobs/jobRunner';

export type { ActiveJobView };

export interface ServeStatus extends StatusResponse {
  readonly extension: StatusResponse['extension'] & {
    /**
     * Jobs the extension's last poll said it runs at once: 1 while its parallel switch is
     * off. Null before its first poll, and from a Voyager that has no parallel jobs.
     */
    readonly maxTasks?: number | null;
  };
  readonly activeJobs?: readonly ActiveJobView[];
}
