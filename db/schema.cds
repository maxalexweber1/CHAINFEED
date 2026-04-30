namespace chainfeed;

using { cuid, managed } from '@sap/cds/common';

entity AggregatedPrices : cuid, managed {
  pair          : String(20);
  price         : Decimal(20,10);
  sourcesUsed   : Integer;
  confidence    : Decimal(5,4);
  deviationPct  : Decimal(8,4);
  validFrom     : Timestamp;
  validUntil    : Timestamp;
  sources       : Composition of many PriceSources on sources.aggregated = $self;
}

entity PriceSources : cuid {
  aggregated    : Association to AggregatedPrices;
  sourceName    : String(50);
  price         : Decimal(20,10);
  txHash        : String(64);
  fetchedAt     : Timestamp;
  rawPayload    : LargeString;
}

entity FeedProviders : cuid, managed {
  name              : String(100);
  walletAddress     : String(120);
  contactEmail      : String(120);
  feeds             : Composition of many ProviderFeeds on feeds.provider = $self;
  totalEarningsUSDM : Decimal(20,6) default 0;
  active            : Boolean default true;
}

entity ProviderFeeds : cuid, managed {
  provider          : Association to FeedProviders;
  feedId            : String(50);
  description       : String(500);
  pricePerCallUSDM  : Decimal(20,6);
  endpointUrl       : String(500);
  totalCalls        : Integer default 0;
  totalEarnings     : Decimal(20,6) default 0;
  active            : Boolean default true;
}

entity FeedReads : cuid {
  feedKind          : String(50);
  feedRef           : String(100);
  consumerWallet    : String(120);
  amountPaidUSDM    : Decimal(20,6);
  paymentTxHash     : String(64);
  servedAt          : Timestamp;
  responsePayload   : LargeString;
}

entity X402PaymentNonces {
  key txHash       : String(64);
  claimedAt        : Timestamp;
  route            : String(200);
  consumerAddr     : String(120);
  amountUnits      : String(20);
  network          : String(20);
}
