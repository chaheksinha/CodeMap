import { formatLabel } from "./format";

export async function loadUsers(): Promise<string> {
  const response = await fetch("http://user-service:8000/users");
  const body = await response.text();
  return formatLabel(body);
}
