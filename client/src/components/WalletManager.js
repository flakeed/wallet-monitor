import React, { useState } from 'react';

const WalletManager = ({ onAddWallet, onAddWalletsBulk, onCreateGroup, groups }) => {
    const [address, setAddress] = useState('');
    const [name, setName] = useState('');
    const [groupId, setGroupId] = useState('');
    const [bulkInput, setBulkInput] = useState('');
    const [groupName, setGroupName] = useState('');
    const [error, setError] = useState(null);
    const [isBulkMode, setIsBulkMode] = useState(false);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!address.trim()) {
            setError('Wallet address is required');
            return;
        }
        if (address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            setError('Invalid Solana wallet address format');
            return;
        }
        setError(null);
        onAddWallet(address.trim(), name.trim() || null, groupId || null);
        setAddress('');
        setName('');
        setGroupId('');
    };

    const handleBulkSubmit = async (e) => {
        e.preventDefault();
        setError(null);

        const wallets = bulkInput
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => {
                const [address, name] = line.split(',').map((s) => s.trim());
                return { address, name: name || null };
            });

        if (wallets.length === 0) {
            setError('No valid wallets provided');
            return;
        }

        try {
            await onAddWalletsBulk(wallets, groupId || null);
            setBulkInput('');
            setGroupId('');
        } catch (err) {
            setError(err.message || 'Failed to import wallets');
        }
    };

    const handleCreateGroup = (e) => {
        e.preventDefault();
        if (!groupName.trim()) {
            setError('Group name is required');
            return;
        }
        setError(null);
        onCreateGroup(groupName.trim());
        setGroupName('');
    };

    return (
        <div className="wallet-manager">
            <h2>Wallet Manager</h2>
            <button onClick={() => setIsBulkMode(!isBulkMode)}>
                {isBulkMode ? 'Single Wallet Mode' : 'Bulk Import Mode'}
            </button>

            {isBulkMode ? (
                <form onSubmit={handleBulkSubmit}>
                    <h3>Bulk Import Wallets</h3>
                    <textarea
                        value={bulkInput}
                        onChange={(e) => setBulkInput(e.target.value)}
                        placeholder={`Paste wallets here (one per line, format: address,name)\nExample:\n9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Wallet 1\n53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC,Important Trader`}
                        rows={10}
                    />
                    <select
                        value={groupId}
                        onChange={(e) => setGroupId(e.target.value)}
                    >
                        <option value="">Select Group (Optional)</option>
                        {groups.map((group) => (
                            <option key={group.id} value={group.id}>
                                {group.name}
                            </option>
                        ))}
                    </select>
                    <button type="submit">Import Wallets</button>
                    <a href={`${API_BASE}/wallets/bulk-template`} download>
                        Download Template
                    </a>
                </form>
            ) : (
                <form onSubmit={handleSubmit}>
                    <h3>Add Single Wallet</h3>
                    <input
                        type="text"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="Enter Solana wallet address"
                    />
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Wallet name (optional)"
                    />
                    <select
                        value={groupId}
                        onChange={(e) => setGroupId(e.target.value)}
                    >
                        <option value="">Select Group (Optional)</option>
                        {groups.map((group) => (
                            <option key={group.id} value={group.id}>
                                {group.name}
                            </option>
                        ))}
                    </select>
                    <button type="submit">Add Wallet</button>
                </form>
            )}

            <form onSubmit={handleCreateGroup}>
                <h3>Create New Group</h3>
                <input
                    type="text"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="Enter group name"
                />
                <button type="submit">Create Group</button>
            </form>

            {error && <div className="error">{error}</div>}
        </div>
    );
};

export default WalletManager;