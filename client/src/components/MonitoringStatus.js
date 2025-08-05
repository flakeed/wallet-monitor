import React from 'react';

function MonitoringStatus({ status, onToggle }) {
  const { isMonitoring, processedSignatures } = status;

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <div className={`w-3 h-3 rounded-full ${isMonitoring ? 'bg-green-500 animate-pulse' : 'bg-red-500'
              }`}></div>
            <span className="text-lg font-semibold text-gray-900">
              Monitoring Status: {isMonitoring ? 'Active' : 'Inactive'}
            </span>
          </div>

          {processedSignatures > 0 && (
            <div className="text-sm text-gray-500">
              Processed: {processedSignatures.toLocaleString()} signatures
            </div>
          )}
        </div>

        <div className="flex space-x-2">
          <button
            onClick={() => onToggle('start')}
            disabled={isMonitoring}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            Start
          </button>
          <button
            onClick={() => onToggle('stop')}
            disabled={!isMonitoring}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            Stop
          </button>
        </div>
      </div>

      <div className="mt-4 text-sm text-gray-600">
        {isMonitoring ? (
          <p>🔍 Actively monitoring all tracked wallets for new token purchases. Updates every 30 seconds.</p>
        ) : (
          <p>⏸️ Monitoring is paused. Click "Start" to begin tracking wallet activities.</p>
        )}
      </div>
    </div>
  );
}

export default MonitoringStatus;