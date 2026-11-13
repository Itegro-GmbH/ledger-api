// Invented camt.053 statements for tests (the parser in `src/camt053/`, the statement import).
// Hausbank, Muster Hosting GmbH and every IBAN here are made up.
export const IBAN = "DE02120300000000202051";

export function entry(fields: { amount: string; indicator: "CRDT" | "DBIT"; date: string; name: string; iban: string; e2e?: string; text?: string; v8?: boolean }) {
  const party = fields.indicator === "CRDT" ? "Dbtr" : "Cdtr";
  const name = fields.v8 ? `<${party}><Pty><Nm>${fields.name}</Nm></Pty></${party}>` : `<${party}><Nm>${fields.name}</Nm></${party}>`;
  return `<Ntry>
    <Amt Ccy="EUR">${fields.amount}</Amt><CdtDbtInd>${fields.indicator}</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt><Dt>${fields.date}</Dt></BookgDt><ValDt><Dt>${fields.date}</Dt></ValDt>
    <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>RCDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn></BkTxCd>
    <NtryDtls><TxDtls>
      <Refs><EndToEndId>${fields.e2e ?? "NOTPROVIDED"}</EndToEndId></Refs>
      <RltdPties>${name}<${party}Acct><Id><IBAN>${fields.iban}</IBAN></Id></${party}Acct></RltdPties>
      ${fields.text ? `<RmtInf><Ustrd>${fields.text}</Ustrd></RmtInf>` : ""}
    </TxDtls></NtryDtls>
  </Ntry>`;
}

export function camt053(version: "02" | "08", entries: string[], balances: { opening: string; closing: string } = { opening: "100.00", closing: "88.10" }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.${version}">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-1</MsgId><CreDtTm>2026-07-31T18:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-2026-07</Id>
      <Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${balances.opening}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-07-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${balances.closing}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-07-31</Dt></Dt></Bal>
      ${entries.join("\n")}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}
