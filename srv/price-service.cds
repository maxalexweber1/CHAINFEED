using chainfeed from '../db/schema';

@path: '/odata/v4/price'
service PriceService {

  @readonly
  entity Prices  as projection on chainfeed.AggregatedPrices;

  @readonly
  entity Sources as projection on chainfeed.PriceSources;

  type AggregatedPriceResult {
    pair          : String;
    price         : Decimal(20,10);
    confidence    : Decimal(5,4);
    sourcesUsed   : Integer;
    deviationPct  : Decimal(8,4);
    validUntil    : Timestamp;
    auditTxHashes : array of String;
  }

  action getBestPrice(pair : String) returns AggregatedPriceResult;

  type TWAPResult {
    pair          : String;
    windowMinutes : Integer;
    twap          : Decimal(20,10);
    samples       : Integer;
    windowStart   : Timestamp;
    windowEnd     : Timestamp;
  }

  action getTWAP(pair : String, windowMinutes : Integer) returns TWAPResult;

  type ArbitrageVenue {
    source : String;
    price  : Decimal(20,10);
  }

  type ArbitrageResult {
    pair       : String;
    bestBuy    : ArbitrageVenue;
    bestSell   : ArbitrageVenue;
    spreadPct  : Decimal(8,4);
    profitable : Boolean;
    venues     : array of ArbitrageVenue;
  }

  action getArbitrageOpportunities(pair : String) returns ArbitrageResult;
}
