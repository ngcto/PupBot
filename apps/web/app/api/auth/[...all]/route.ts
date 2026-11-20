import { auth } from "@pupbot/db";

export function GET(request: Request) {
  return auth().handler(request);
}

export function POST(request: Request) {
  return auth().handler(request);
}
