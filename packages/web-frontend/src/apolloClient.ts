import { ApolloClient, InMemoryCache, HttpLink, split } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';

const httpUri = import.meta.env.VITE_GRAPHQL_URL ?? 'http://localhost:4000/graphql';
const wsUri = import.meta.env.VITE_GRAPHQL_WS_URL ?? httpUri.replace(/^http/, 'ws');

const httpLink = new HttpLink({ uri: httpUri, credentials: 'same-origin' });

const wsLink = typeof window === 'undefined'
  ? null
  : new GraphQLWsLink(
      createClient({
        url: wsUri,
        retryAttempts: Infinity,
        shouldRetry: () => true
      })
    );

const link = wsLink
  ? split(
      ({ query }) => {
        const definition = getMainDefinition(query);
        return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
      },
      wsLink,
      httpLink
    )
  : httpLink;

export const client = new ApolloClient({
  link,
  cache: new InMemoryCache({ addTypename: true })
});
