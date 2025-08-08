import React from 'react';

function WalletList({ wallets, onRemoveWallet, onUpdateWalletGroups, groups }) {
  const handleRemoveWallet = async (address) => {
    try {
      await onRemoveWallet(address);
    } catch (error) {
      console.error('Error removing wallet:', error);
    }
  };

  const handleGroupToggle = async (walletId, groupId, isAssigned) => {
    try {
      await onUpdateWalletGroups(walletId, groupId, isAssigned ? 'remove' : 'add');
    } catch (error) {
      console.error('Error updating wallet groups:', error);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-4">Monitored Wallets</h2>
      {wallets.length === 0 ? (
        <p className="text-gray-500">No wallets are currently being monitored.</p>
      ) : (
        <div className="space-y-4">
          {wallets.map(wallet => (
            <div key={wallet.id} className="border p-4 rounded-lg">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-medium text-gray-900">
                    {wallet.name || wallet.address.slice(0, 8) + '...'}
                  </div>
                  <div className="text-sm text-gray-500">{wallet.address}</div>
                </div>
                <button
                  onClick={() => handleRemoveWallet(wallet.address)}
                  className="text-red-600 hover:text-red-800"
                >
                  Remove
                </button>
              </div>
              <div className="mt-2">
                <span className="text-sm text-gray-700">Groups:</span>
                <div className="flex flex-wrap gap-2 mt-1">
                  {groups.length === 0 ? (
                    <span className="text-sm text-gray-500">No groups available</span>
                  ) : (
                    groups.map(group => {
                      const isAssigned = wallet.groupIds?.includes(group.id);
                      return (
                        <button
                          key={group.id}
                          onClick={() => handleGroupToggle(wallet.id, group.id, isAssigned)}
                          className={`text-sm px-2 py-1 rounded ${isAssigned ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                        >
                          {group.name}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="mt-2 text-sm text-gray-600">
                Total Transactions: {wallet.stats?.totalTransactions || 0} | 
                Net SOL: {wallet.stats?.netSOL || 0}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WalletList;