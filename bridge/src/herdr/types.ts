export interface HerdrRequest {
  id: string;
  method: string;
  params: object;
}

export interface HerdrErrorBody {
  code: string;
  message: string;
}

export interface HerdrResponse {
  id: string;
  result?: unknown;
  error?: HerdrErrorBody;
}
