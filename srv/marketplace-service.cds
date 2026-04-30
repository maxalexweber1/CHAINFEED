using chainfeed from '../db/schema';

@path: '/odata/v4/marketplace'
service MarketplaceService {

  entity Providers as projection on chainfeed.FeedProviders;
  entity Feeds     as projection on chainfeed.ProviderFeeds;

  @readonly
  entity Reads     as projection on chainfeed.FeedReads;

  action registerProvider(
    name          : String,
    walletAddress : String,
    contactEmail  : String
  ) returns Providers;
}
