// client/src/components/Header.js - ИСПРАВЛЕНИЕ для передачи Telegram ID

import React, { useState } from 'react';

function Header({ user, onLogout, onOpenAdmin, isSharedSession }) {
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleLogoutClick = () => {
    setShowUserMenu(false);
    onLogout();
  };

  const handleAdminClick = () => {
    setShowUserMenu(false);
    console.log('🔑 Opening admin panel for user:', user);
    console.log('📋 User details:', {
      id: user.id,
      telegramId: user.telegramId,
      isAdmin: user.isAdmin,
      isSharedSession
    });
    onOpenAdmin();
  };

  return (
    <div className="text-center mb-8 relative">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">WalletPulse</h1>
          <p className="text-gray-600">Solana Wallet Monitor</p>
          {/* Индикатор общей сессии */}
          {isSharedSession && (
            <div className="mt-2">
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832L14 10.202V11a1 1 0 102 0V8.5a.5.5 0 00-.5-.5H14V7a1 1 0 10-2 0v1.798l-4.445-2.63z" clipRule="evenodd" />
                </svg>
                Shared Session Active
              </span>
            </div>
          )}
        </div>
        
        {user && (
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className={`flex items-center space-x-3 rounded-lg shadow-sm border p-3 hover:shadow-md transition-shadow ${
                isSharedSession 
                  ? 'bg-green-50 border-green-200 hover:bg-green-100' 
                  : 'bg-white hover:bg-gray-50'
              }`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                isSharedSession ? 'bg-green-600' : 'bg-blue-600'
              }`}>
                <span className="text-white text-sm font-medium">
                  {user.firstName?.[0]?.toUpperCase() || user.username?.[0]?.toUpperCase() || 'U'}
                </span>
              </div>
              <div className="text-left">
                <div className="text-sm font-medium text-gray-900 flex items-center">
                  {user.firstName} {user.lastName}
                  {isSharedSession && (
                    <svg className="w-3 h-3 ml-1 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
                <div className="text-xs text-gray-500 flex items-center">
                  {user.username ? `@${user.username}` : `ID: ${user.telegramId}`}
                  {user.isAdmin && (
                    <span className="ml-2 px-1 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">Admin</span>
                  )}
                  {isSharedSession && (
                    <span className="ml-2 px-1 py-0.5 bg-green-100 text-green-700 rounded text-xs">Shared</span>
                  )}
                </div>
              </div>
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg border z-50">
                <div className={`p-4 border-b ${isSharedSession ? 'bg-green-50' : 'bg-gray-50'}`}>
                  <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      isSharedSession ? 'bg-green-600' : 'bg-blue-600'
                    }`}>
                      <span className="text-white font-medium">
                        {user.firstName?.[0]?.toUpperCase() || user.username?.[0]?.toUpperCase() || 'U'}
                      </span>
                    </div>
                    <div>
                      <div className="font-medium text-gray-900">
                        {user.firstName} {user.lastName}
                      </div>
                      <div className="text-sm text-gray-500">
                        {user.username ? `@${user.username}` : `Telegram ID: ${user.telegramId}`}
                      </div>
                      <div className="flex items-center mt-1">
                        {user.isAdmin && (
                          <div className="text-xs text-purple-600 font-medium mr-2">Administrator</div>
                        )}
                        {isSharedSession && (
                          <div className="text-xs text-green-600 font-medium flex items-center">
                            <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832L14 10.202V11a1 1 0 102 0V8.5a.5.5 0 00-.5-.5H14V7a1 1 0 10-2 0v1.798l-4.445-2.63z" clipRule="evenodd" />
                            </svg>
                            Shared Session
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="py-2">
                  {user.isAdmin && (
                    <button
                      onClick={handleAdminClick}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span>Admin Panel</span>
                    </button>
                  )}

                  {isSharedSession && (
                    <div className="px-4 py-2 text-xs text-green-700 bg-green-50 mx-2 rounded">
                      <div className="flex items-center">
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <div>
                          <div className="font-medium">Shared Session</div>
                          <div className="text-xs">All users share the same session token</div>
                          <div className="text-xs mt-1">Your ID: {user.telegramId}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="border-t my-2"></div>
                  
                  <button
                    onClick={handleLogoutClick}
                    className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center space-x-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    <span>{isSharedSession ? 'Sign Out (Local)' : 'Sign Out'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Overlay to close menu when clicking outside */}
            {showUserMenu && (
              <div 
                className="fixed inset-0 z-40" 
                onClick={() => setShowUserMenu(false)}
              ></div>
            )}
          </div>
        )}
      </div>

      {/* Session info banner */}
      {user && isSharedSession && (
        <div className="mt-4 flex justify-center">
          <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 flex items-center space-x-2">
            <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clipRule="evenodd" />
            </svg>
            <span className="text-sm text-green-800">
              <span className="font-medium">Shared Session Active</span>
              <span className="mx-2">•</span>
              <span>Logged in as {user.firstName || user.username} (ID: {user.telegramId})</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default Header;